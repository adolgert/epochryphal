// State the extension keeps for one session. Everything here can be rebuilt from disk (plan Section 8).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EventLog, Mode, StepRef } from "../core/log.ts";
import type { PlanStore } from "../core/plan.ts";

/** The active step: what the log records, plus what the system-prompt line needs. */
export interface ActiveStep extends StepRef {
	kind: string;
	goal: string;
	/** The git commit when the step started, from its step_start event; null when not found. */
	commit: string | null;
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
	/** The most recent context, for reporting problems to the person. */
	ctx: ExtensionContext | null;
}

export function newState(): HarnessState {
	return { harnessDir: "harness", root: null, session: null, mode: "supervised", step: null, log: null, store: null, ctx: null };
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
