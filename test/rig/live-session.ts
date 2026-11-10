// Level 4 helper: a real pi session in-process with the harness extension and a REAL, PAID model,
// named by HARNESS_LIVE_MODEL as <provider>/<model id>. Used only by test/live. Unlike
// runSdkSession it loads no scripted model and leaves provider credentials in place: pi finds
// them as it always does, in the environment or in its configuration directory (getAgentDir()).
//
// Spending is bounded three ways: the step's budget in harness.json with rules.supervised "stop";
// a cap on the whole session's tokens and cost, which aborts the run once passed (it also covers
// prompts sent when no step is active); and a time limit per prompt, after which the run is aborted.
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { noCacheWarming } from "../../src/runner/run.ts";
import { EXTENSION_PATH, requestedRuns, settleSession } from "./sdk-session.ts";
import type { ToyProject } from "./toy-project.ts";

/** The model the live tests use, or undefined: then every live test is skipped. */
export const LIVE_MODEL = process.env.HARNESS_LIVE_MODEL;

export interface SpendCap {
	tokens: number;
	cost_usd: number;
}

export interface LiveSessionOptions {
	project: ToyProject;
	/** <provider>/<model id>. */
	model: string;
	cap: SpendCap;
	/** Longest time one prompt may take before its run is aborted. */
	promptTimeoutMs: number;
}

export interface LiveSession {
	session: AgentSession;
	/** Tokens and cost of every model call in the session so far, and whether the cap stopped it. */
	spent: { tokens: number; cost_usd: number; capped: boolean };
	/** Send a prompt or slash command and wait until pi has settled, or abort at the time limit. */
	prompt(text: string): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * An extension that adds up every assistant message's usage and aborts the run once the session
 * has used more than `cap`. The abort comes after the model call that passed the cap.
 */
function spendCap(cap: SpendCap, spent: LiveSession["spent"]) {
	return (pi: ExtensionAPI) => {
		pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "assistant") return;
			spent.tokens += event.message.usage.totalTokens;
			spent.cost_usd += event.message.usage.cost.total;
			if (spent.tokens > cap.tokens || spent.cost_usd > cap.cost_usd) {
				spent.capped = true;
				ctx.abort();
			}
		});
		pi.on("tool_call", async () => (spent.capped ? { block: true, reason: "The live test's spending cap was reached. Stop.", terminate: true } : undefined));
	};
}

export async function runLiveSession(options: LiveSessionOptions): Promise<LiveSession> {
	const slash = options.model.indexOf("/");
	if (slash <= 0) throw new Error(`HARNESS_LIVE_MODEL must be <provider>/<model id>, got "${options.model}"`);
	const [provider, modelId] = [options.model.slice(0, slash), options.model.slice(slash + 1)];
	const { project } = options;
	const agentDir = getAgentDir();
	const spent = { tokens: 0, cost_usd: 0, capped: false };
	const { observer, observe } = requestedRuns();

	// In-memory settings: the person's own settings and extensions do not apply. Cache warming is
	// off, because its requests are invisible to the harness and to the cap (docs/pi-facts.md, Step 9).
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
	const resourceLoader = new DefaultResourceLoader({
		cwd: project.dir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		noThemes: true,
		additionalExtensionPaths: [EXTENSION_PATH],
		extensionFactories: [observe, noCacheWarming, spendCap(options.cap, spent)],
	});
	await resourceLoader.reload();
	const failed = resourceLoader.getExtensions().errors;
	if (failed.length > 0) throw new Error(`runLiveSession: cannot load ${failed.map((f) => `${f.path}: ${f.error}`).join("; ")}`);
	const { session } = await createAgentSession({ cwd: project.dir, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(project.dir) });
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_start") observer.pending = Math.max(0, observer.pending - 1);
	});
	await session.bindExtensions({});
	const model = session.modelRuntime.getModel(provider, modelId);
	if (!model) {
		session.dispose();
		throw new Error(`runLiveSession: pi has no model ${modelId} from provider ${provider}`);
	}
	await session.setModel(model);

	return {
		session,
		spent,
		async prompt(text) {
			// session.prompt() itself waits for a plain prompt's run, so the time limit covers it too.
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				void session.abort();
			}, options.promptTimeoutMs);
			try {
				await session.prompt(text);
				await settleSession(session, observer, options.promptTimeoutMs, "runLiveSession");
			} catch (e) {
				await session.abort();
				throw e;
			} finally {
				clearTimeout(timer);
			}
			if (timedOut) throw new Error(`runLiveSession: the prompt took longer than ${options.promptTimeoutMs} ms and was aborted`);
		},
		async dispose() {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			unsubscribe();
			session.dispose();
		},
	};
}
