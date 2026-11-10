// Level 2 helper: a real pi session in-process, with the harness extension and the scripted model.
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type ModelRequest,
	readRequests,
	SCRIPT_EXHAUSTED,
	SCRIPTED_MODEL_ID,
	SCRIPTED_MODEL_PATH,
	SCRIPTED_PROVIDER,
	type ScriptEntry,
	scrubbedEnv,
	writeScript,
} from "./script.ts";
import { makeToyProject, type ToyProject } from "./toy-project.ts";
import { createHarnessExtension, type HarnessOptions } from "../../src/extension/index.ts";

export const EXTENSION_PATH = new URL("../../src/extension/index.ts", import.meta.url).pathname;

export interface SdkSessionOptions {
	script: ScriptEntry[];
	/** Toy project to run in. When omitted, one is made and removed on dispose. */
	project?: ToyProject;
	/** Extension paths to load besides the scripted model. Default: the harness extension. */
	extensions?: string[];
	/** Load the harness extension in-process with these options (for example a fake clock) instead of by path. */
	harness?: HarnessOptions;
	/** More extensions to load in-process, such as a test tool. */
	factories?: ((pi: ExtensionAPI) => void)[];
	/** Store the session in a file under this directory instead of in memory. */
	sessionDir?: string;
	/** Settings on top of the defaults (compaction and retry off), such as compaction.keepRecentTokens. */
	settings?: Record<string, unknown>;
	/** Longest time prompt() waits for pi to settle. Default 10 s. */
	settleTimeoutMs?: number;
}

export interface ToolResultSummary {
	toolName: string;
	text: string;
	isError: boolean;
}

export interface SdkSession {
	session: AgentSession;
	project: ToyProject;
	/** Every session event, in order. */
	events: AgentSessionEvent[];
	/**
	 * Send a prompt or slash command, then wait until pi has settled, including a run that a
	 * command started with sendUserMessage. Throws if the script ran out.
	 */
	prompt(text: string): Promise<void>;
	/** Wait until pi has settled, including runs that were asked for but have not started. */
	settle(): Promise<void>;
	requests(): ModelRequest[];
	assistantMessages(): AssistantMessage[];
	toolResults(): ToolResultSummary[];
	lastAssistantText(): string | undefined;
	dispose(): Promise<void>;
}

const textOf = (content: readonly { type: string; text?: string }[]) =>
	content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");

/** Replace process.env with a copy that has no provider credentials. */
function scrubProcessEnv(): void {
	const clean = scrubbedEnv();
	for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
}

export async function runSdkSession(options: SdkSessionOptions): Promise<SdkSession> {
	const ownsProject = options.project === undefined;
	const project = options.project ?? makeToyProject();
	const work = join(project.workDir, `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const agentDir = join(work, "pi-agent");
	mkdirSync(agentDir, { recursive: true });
	const { scriptPath, requestsPath } = writeScript(work, options.script);

	scrubProcessEnv();
	process.env.HARNESS_TEST_SCRIPT = scriptPath;
	process.env.HARNESS_TEST_REQUESTS = requestsPath;

	// Counts runs that have been asked for (an idle `input`) but have not started yet. A command
	// that calls sendUserMessage returns before its run starts, so prompt() must wait for it.
	const observer = { pending: 0 };
	const observe = (pi: ExtensionAPI) => {
		pi.on("input", async (event) => {
			if (event.streamingBehavior === undefined) observer.pending++;
		});
	};

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, ...options.settings });
	const resourceLoader = new DefaultResourceLoader({
		cwd: project.dir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		noThemes: true,
		additionalExtensionPaths: [...(options.extensions ?? (options.harness ? [] : [EXTENSION_PATH])), SCRIPTED_MODEL_PATH],
		extensionFactories: [observe, ...(options.harness ? [createHarnessExtension(options.harness)] : []), ...(options.factories ?? [])],
	});
	await resourceLoader.reload();
	const sessionManager = options.sessionDir
		? SessionManager.create(project.dir, options.sessionDir)
		: SessionManager.inMemory(project.dir);
	const { session } = await createAgentSession({
		cwd: project.dir,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager,
	});

	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => {
		events.push(event);
		if (event.type === "agent_start") observer.pending = Math.max(0, observer.pending - 1);
	});
	await session.bindExtensions({});

	// pi picks a model before extension providers are in place and may fall back to a real one.
	const model = session.modelRuntime.getModel(SCRIPTED_PROVIDER, SCRIPTED_MODEL_ID);
	if (!model) throw new Error("runSdkSession: the scripted model is not registered");
	await session.setModel(model);
	if (session.model?.provider !== SCRIPTED_PROVIDER) {
		throw new Error(`runSdkSession: refusing to run with model ${session.model?.provider}/${session.model?.id}`);
	}

	const assistantMessages = () => session.messages.filter((m): m is AssistantMessage => m.role === "assistant");

	const settle = async () => {
		const deadline = Date.now() + (options.settleTimeoutMs ?? 10_000);
		let quietChecks = 0;
		while (quietChecks < 3) {
			await new Promise((resolve) => setImmediate(resolve));
			if (observer.pending === 0 && session.isIdle) {
				quietChecks++;
				continue;
			}
			quietChecks = 0;
			if (Date.now() > deadline) {
				throw new Error(`runSdkSession: pi did not settle within ${options.settleTimeoutMs ?? 10_000} ms`);
			}
			await Promise.race([session.waitForIdle(), new Promise((resolve) => setTimeout(resolve, 10))]);
		}
	};

	return {
		session,
		project,
		events,
		async prompt(text: string) {
			await session.prompt(text);
			await settle();
			const exhausted = assistantMessages().some((m) => textOf(m.content) === SCRIPT_EXHAUSTED);
			if (exhausted) {
				throw new Error(`${SCRIPT_EXHAUSTED}: the model was asked for more responses than the script has (${options.script.length})`);
			}
		},
		settle,
		requests: () => readRequests(requestsPath),
		assistantMessages,
		toolResults: () =>
			session.messages
				.filter((m): m is ToolResultMessage => m.role === "toolResult")
				.map((m) => ({ toolName: m.toolName, text: textOf(m.content), isError: m.isError })),
		lastAssistantText: () => {
			const last = assistantMessages().at(-1);
			return last ? textOf(last.content) : undefined;
		},
		async dispose() {
			// AgentSession.dispose() alone does not emit session_shutdown; pi's runtime emits it first.
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			unsubscribe();
			session.dispose();
			if (ownsProject) project.cleanup();
		},
	};
}
