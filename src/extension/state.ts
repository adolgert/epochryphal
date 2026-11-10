// State the extension keeps for one session. Everything here can be rebuilt from disk (plan Section 8).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EventLog, Mode, StepRef } from "../core/log.ts";

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
	step: StepRef | null;
	log: EventLog | null;
	/** The most recent context, for reporting problems to the person. */
	ctx: ExtensionContext | null;
}

export function newState(): HarnessState {
	return { harnessDir: "harness", root: null, session: null, mode: "supervised", step: null, log: null, ctx: null };
}

/** Tell the person about a problem: a notice in a UI, standard error otherwise. */
export function report(state: HarnessState, message: string, level: "info" | "warning" | "error" = "error"): void {
	const ctx = state.ctx;
	try {
		if (ctx?.hasUI) ctx.ui.notify(`harness: ${message}`, level);
		else process.stderr.write(`harness: ${message}\n`);
	} catch {
		process.stderr.write(`harness: ${message}\n`);
	}
}
