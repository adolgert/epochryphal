// The headless runner (plan Section 7.9): runs a plan's pending steps with nobody present, through
// pi's SDK, with the harness extension loaded in-process in headless mode. The loop for one step
// is core/headless.ts; this file opens and closes sessions, reads the control file, and prints
// the live feed.
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "../core/clock.ts";
import { ConfigError, loadConfig } from "../core/config.ts";
import { ControlReader, controlPath } from "../core/control.ts";
import { type FeedTotals, feedLine } from "../core/feed.ts";
import { runStepLoop } from "../core/headless.ts";
import type { StepRef } from "../core/log.ts";
import { activeStep, firstPending, PlanStore } from "../core/plan.ts";
import type { RunnerHandle } from "../extension/headless.ts";
import { createHarnessExtension } from "../extension/index.ts";
import { isRefusal } from "../extension/steps.ts";

export type SessionMode = "fresh_per_step" | "continue";

export interface RunOptions {
	project: string;
	plan: string;
	/** <provider>/<model id>. */
	model: string;
	/** Most steps to attempt. Default: all pending steps. */
	steps?: number;
	/** Default: headless.session_mode from harness.json. */
	sessionMode?: SessionMode;
	/** pi extensions to load by path, as `pi -e` does: a project's own tools, or a test model. */
	extensions?: string[];
	/** Directory for session files. Default: pi's session directory for the project. */
	sessionDir?: string;
	/** pi's configuration directory. Default: pi's own (PI_CODING_AGENT_DIR, else ~/.pi/agent). */
	agentDir?: string;
	/** Extensions to load in-process, for programs that embed the runner and for tests. */
	factories?: ((pi: ExtensionAPI) => void)[];
	/** How often the control file is read. Default 250 ms. */
	pollMs?: number;
	clock?: Clock;
	/** Where the feed and errors go. Default: standard output and standard error. */
	out?: (line: string) => void;
	err?: (line: string) => void;
}

/** A problem with the arguments or the project, found before any step starts: exit code 1. */
class RunError extends Error {}

/**
 * pi re-sends a request now and then to keep a provider's prompt cache warm, outside any event the
 * harness logs (docs/pi-facts.md, Step 9). A headless run refuses every refresh, so all model
 * usage goes through the step budget.
 */
export function noCacheWarming(pi: ExtensionAPI): void {
	pi.on("cache_warming_decision", () => ({ action: "stop" as const }));
}

interface Live {
	session: AgentSession;
	handle: RunnerHandle;
	/** A step has run in this session. */
	used: boolean;
}

async function close(session: AgentSession): Promise<void> {
	// AgentSession.dispose() alone does not emit session_shutdown (docs/pi-facts.md).
	await session.abort();
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
}

/** Run the plan. Returns the exit code: 0 every attempted step passed, 2 one did not, 1 a program error. */
export async function runHeadless(o: RunOptions): Promise<number> {
	const out = o.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
	const err = o.err ?? ((line: string) => void process.stderr.write(`${line}\n`));
	const root = resolve(o.project);
	const slash = o.model.indexOf("/");
	const [provider, modelId] = [o.model.slice(0, slash), o.model.slice(slash + 1)];
	const sessionDir = o.sessionDir ? resolve(o.sessionDir) : undefined;

	let mode: SessionMode;
	let maxIterations: number;
	try {
		if (slash <= 0 || modelId === "") throw new RunError(`--model must be <provider>/<model id>, got "${o.model}"`);
		if (!existsSync(join(root, "harness", "harness.json"))) throw new RunError(`no harness/harness.json in ${root}`);
		const config = loadConfig(root, "harness");
		mode = o.sessionMode ?? config.headless.session_mode;
		maxIterations = config.rules.max_iterations;
		const store = new PlanStore(root);
		const plan = store.read(o.plan).plan;
		if (plan.exit) throw new RunError(`plan ${o.plan} is closed (${plan.exit.decision}); nothing to run`);
		const active = activeStep(plan);
		if (active) throw new RunError(`step ${active.id} of plan ${o.plan} is already active, left by an earlier run or a supervised session; finish it or /abandon it in pi, then run again`);
		const current = store.activeId();
		if (current !== null && current !== o.plan && store.exists(current)) {
			const other = activeStep(store.read(current).plan);
			if (other) throw new RunError(`plan ${current} is the active plan and its step ${other.id} is active; finish it or /abandon it in pi before running ${o.plan}`);
		}
		if (!firstPending(plan)) {
			out(`harness-run: plan ${o.plan} has no pending step; nothing to run`);
			return 0;
		}
		store.setActive(o.plan);
	} catch (e) {
		if (!(e instanceof RunError || e instanceof ConfigError || isRefusal(e))) throw e;
		err(`harness-run: ${e.message}`);
		return 1;
	}

	const totals: FeedTotals = { tokens: 0, cost_usd: 0 };
	const onEvent = (record: Record<string, unknown>) => out(feedLine(record, totals));

	const open = async (): Promise<Live> => {
		let handle: RunnerHandle | undefined;
		const agentDir = o.agentDir ?? getAgentDir();
		const settingsManager = SettingsManager.create(root, agentDir);
		const harness = createHarnessExtension({ mode: "headless", clock: o.clock, onEvent, connect: (h) => (handle = h) });
		// noExtensions: a harness also listed in the project's settings would otherwise load twice.
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			noExtensions: true,
			additionalExtensionPaths: (o.extensions ?? []).map((p) => resolve(p)),
			extensionFactories: [harness, noCacheWarming, ...(o.factories ?? [])],
		});
		await resourceLoader.reload();
		const failed = resourceLoader.getExtensions().errors;
		if (failed.length > 0) throw new RunError(`cannot load extension ${failed.map((f) => `${f.path}: ${f.error}`).join("; ")}`);
		const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.create(root, sessionDir) });
		await session.bindExtensions({});
		// pi picks a model before extension providers are in place; set the one asked for.
		const model = session.modelRuntime.getModel(provider, modelId);
		if (!model || !handle) {
			await close(session);
			throw new RunError(model ? "the harness extension did not load" : `unknown model ${o.model}; pi has no model ${modelId} from provider ${provider}`);
		}
		await session.setModel(model);
		out(`harness-run: session file ${session.sessionFile ?? "(not saved)"}`);
		return { session, handle, used: false };
	};

	// Control commands. Only lines written after this point count.
	const control = new ControlReader(controlPath(root));
	let live: Live | null = null;
	let stopRequested = false;
	let checkAbort: AbortController | null = null;
	const poll = () => {
		let read;
		try {
			read = control.poll();
		} catch (e) {
			return err(`harness-run: cannot read ${control.path}: ${(e as Error).message}`);
		}
		const { commands, problems } = read;
		for (const p of problems) err(`harness-run: ${p}`);
		for (const c of commands) {
			const l: Live | null = live;
			if (c.cmd === "stop") {
				stopRequested = true;
				checkAbort?.abort();
				if (l && !l.session.isIdle) {
					l.handle.ownAbort();
					l.session.abort().catch((e: Error) => err(`harness-run: abort failed: ${e.message}`));
				}
			} else if (!l) {
				err(`harness-run: steer ignored, no session is open: ${c.text.slice(0, 80)}`);
			} else {
				// Source "rpc" makes the extension log it as an interruption with how "control".
				l.session.steer(c.text, undefined, { source: "rpc" }).catch((e: Error) => err(`harness-run: steer failed: ${e.message}`));
			}
		}
	};
	const timer = setInterval(poll, o.pollMs ?? 250);

	const loopSession = (l: Live, ref: StepRef) => ({
		prompt: async (text: string) => {
			// Source "extension": the harness's own message, not an interruption; no command expansion.
			await l.session.prompt(text, { source: "extension", expandPromptTemplates: false });
			await l.session.waitForIdle();
		},
		active: () => l.handle.active(ref),
		check: async () => {
			checkAbort = new AbortController();
			try {
				return await l.handle.check(ref, checkAbort.signal);
			} finally {
				checkAbort = null;
			}
		},
		stop: l.handle.stop,
		stopRequested: () => stopRequested,
	});

	let code = 0;
	try {
		for (let attempted = 0; attempted < (o.steps ?? Infinity); attempted++) {
			if (stopRequested) {
				err("harness-run: stopped by harness-ctl stop between steps");
				code = 2;
				break;
			}
			live ??= await open();
			let plan = await live.handle.plan();
			if (!firstPending(plan)) break;
			if (live.used && mode === "fresh_per_step") {
				await close(live.session);
				live = null; // So a failure to open leaves nothing to close.
				live = await open();
				plan = await live.handle.plan();
			}
			const next = firstPending(plan);
			if (!next) break;
			const { ref, prompt } = live.handle.start(plan, next);
			live.used = true;
			await runStepLoop(loopSession(live, ref), { id: next.id, prompt }, maxIterations);
			const record = live.handle.record(ref);
			if (record?.outcome !== "passed") {
				const how = record ? `${record.outcome}${record.reason ? ` (${record.reason})` : ""}` : "without a step record";
				err(`harness-run: step ${next.id} ended ${how}. The run ends here; see ${live.session.sessionFile ?? "the event log"}`);
				code = 2;
				break;
			}
		}
	} catch (e) {
		const known = e instanceof RunError || isRefusal(e);
		err(`harness-run: ${known ? e.message : `${(e as Error).stack ?? String(e)}\nA step that was running stays active; finish it or /abandon it in pi.`}`);
		code = 1;
	} finally {
		clearInterval(timer);
		if (live) await close(live.session);
	}
	return code;
}
