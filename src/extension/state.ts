// State the extension keeps for one session. Everything here can be rebuilt from disk (plan Section 8).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newTracker, rebuildTracker, sameAttempt, track, type Tracker } from "../core/budget.ts";
import type { Budget } from "../core/config.ts";
import { type EventLog, type Mode, readEvents, type StepRef } from "../core/log.ts";
import type { PlanStore } from "../core/plan.ts";

/** The active step: what the log records, plus what the system-prompt line needs. */
export interface ActiveStep extends StepRef {
	kind: string;
	goal: string;
	/** The git commit when the step started, from its step_start event; null when not found. */
	commit: string | null;
	/** The step's own budget fields from the plan file, on top of its kind's budget. */
	budget: Partial<Budget>;
}

export interface HarnessState {
	/** Directory under the project root that holds harness.json, plans, and logs. */
	harnessDir: string;
	/**
	 * Project root: the nearest directory at or above pi's working directory that holds
	 * <harnessDir>/harness.json. Null when there is none; the harness is then inactive.
	 */
	root: string | null;
	session: string | null;
	mode: Mode;
	step: ActiveStep | null;
	log: EventLog | null;
	/** Plan files; null while the harness is inactive. */
	store: PlanStore | null;
	/**
	 * A step prompt sent with sendUserMessage whose run has not begun. pi starts that run a moment
	 * later, so a command can end the step first (docs/pi-facts.md, Step 6).
	 */
	starting: (StepRef & { prompt: string }) | null;
	/** The harness itself aborted the run (for /abandon or a stop rule); that abort is not an interruption. */
	ownAbort: boolean;
	/**
	 * The active attempt's budget tracker. It follows the event log as records are written, and is
	 * rebuilt from events.jsonl when it does not match the active step (after a restart).
	 */
	tracker: Tracker | null;
	/** Set when a stop rule ended the step during this run: why further tool calls are blocked. */
	halt: string | null;
	/** The most recent context, for reporting problems to the person. */
	ctx: ExtensionContext | null;
}

export function newState(): HarnessState {
	return { harnessDir: "harness", root: null, session: null, mode: "supervised", step: null, log: null, store: null, starting: null, ownAbort: false, tracker: null, halt: null, ctx: null };
}

/** The active step's tracker, rebuilt from the event log when it is missing or for another attempt. */
export function currentTracker(state: HarnessState): Tracker | null {
	const step = state.step;
	if (!step || !state.log) return null;
	if (!state.tracker || !sameAttempt(step, state.tracker.ref)) {
		state.tracker = rebuildTracker(readEvents(state.log.path), step);
	}
	return state.tracker;
}

/** Feed a record just written to the event log to the tracker. A step_start begins a fresh one. */
export function followLog(state: HarnessState, record: Record<string, unknown>): void {
	const step = state.step;
	if (record.type === "step_start" && step && sameAttempt(step, record)) state.tracker = newTracker(step);
	if (state.tracker) track(state.tracker, record);
}

function tell(state: HarnessState, message: string, level: "info" | "warning" | "error"): void {
	const ctx = state.ctx;
	try {
		if (ctx?.hasUI) ctx.ui.notify(message, level);
		else process.stderr.write(`${message}\n`);
	} catch {
		process.stderr.write(`${message}\n`);
	}
}

/** Tell the person about a problem: a notice in a UI, standard error otherwise. */
export function report(state: HarnessState, message: string, level: "info" | "warning" | "error" = "error"): void {
	tell(state, `harness: ${message}`, level);
}

/** Tell the person something that is not a problem, such as a status display or a confirmation. */
export function say(state: HarnessState, message: string): void {
	tell(state, message, "info");
}
