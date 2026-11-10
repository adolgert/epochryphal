// /run-plan (plan Section 7.8): the decision at each step boundary, the boundary summary, and the
// command's argument. Pure functions; the adapter wires them to pi's agent_settled.
import { CommandError } from "./commands.ts";
import type { StepStatus } from "./plan.ts";

/** The person's answer at a boundary. */
export type BoundaryAnswer = "continue" | "stop" | "stop_edit";

/**
 * How the next step is approved: "auto" and "ask" from run_plan.approve; once asked, the answer;
 * "no_ui" when approve is "ask" and there is nobody to ask.
 */
export type Approval = "auto" | "ask" | "no_ui" | BoundaryAnswer;

export interface BoundaryInput {
	/** The step this run of the mode started, as the plan has it now. "missing" when that attempt is gone. */
	step: { id: string; status: StepStatus | "missing"; reason?: string };
	/** The run that just settled was aborted. */
	aborted: boolean;
	/** The first pending step, if any. */
	next: { id: string } | null;
	/** Steps started by this /run-plan, and how many it may start (null: no limit). */
	started: number;
	limit: number | null;
	/** /stop-plan was given. */
	stopRequested: boolean;
	approval: Approval;
}

/**
 * continue: start the next step. ask: ask the person, then decide again with the answer.
 * end: the mode did what it was asked (no pending step, or n steps run). stop: anything else.
 */
export type BoundaryDecision = { action: "continue" } | { action: "ask" } | { action: "end" | "stop"; why: string; edit?: boolean };

/**
 * The decision after the agent's run has settled. Only a step that passed, in a run that was not
 * aborted, can lead to the next step; every other case ends the mode. This keeps the mode from looping.
 */
export function decideBoundary(b: BoundaryInput): BoundaryDecision {
	const { id, status } = b.step;
	if (status === "missing") return { action: "stop", why: `step ${id} is no longer in the plan as run-plan started it` };
	if (status === "blocked" || status === "abandoned" || status === "stopped") {
		return { action: "stop", why: `step ${id} ended ${status}${b.step.reason ? `: ${b.step.reason}` : ""}` };
	}
	if (b.aborted) return { action: "stop", why: `the run was aborted; step ${id} is ${status}` };
	if (status === "active") {
		return { action: "stop", why: `the agent stopped without calling submit or report_blocked; step ${id} is still active. Tell the agent to go on, or /abandon the step` };
	}
	if (status !== "passed") return { action: "stop", why: `step ${id} is ${status}` };
	if (b.stopRequested) return { action: "stop", why: "/stop-plan was given" };
	if (b.limit !== null && b.started >= b.limit) return { action: "end", why: `${b.started} step${b.started === 1 ? "" : "s"} run, as asked` };
	if (!b.next) return { action: "end", why: "the plan has no pending step left" };
	switch (b.approval) {
		case "auto":
		case "continue":
			return { action: "continue" };
		case "ask":
			return { action: "ask" };
		case "stop":
			return { action: "stop", why: "you chose stop" };
		case "stop_edit":
			return { action: "stop", why: "you chose stop and edit", edit: true };
		case "no_ui":
			return { action: "stop", why: `run_plan.approve is "ask", but there is no user interface to ask in, so ${b.next.id} was not started. Set run_plan.approve to "auto" to run without asking` };
	}
}

export interface BoundarySummary {
	step: { id: string; goal: string };
	/** The summary of the step's last check, or null when the log has none. */
	check: string | null;
	tokens: number;
	cost_usd: number;
	next: { id: string; goal: string } | null;
}

const MAX_CHECK_CHARS = 300;

/** What the person reads at a boundary: the step's goal, its check, its usage, and the next goal. */
export function boundarySummary(s: BoundarySummary): string {
	const check = s.check === null ? "(no check summary in the log)" : s.check.length > MAX_CHECK_CHARS ? `${s.check.slice(0, MAX_CHECK_CHARS)}…` : s.check;
	return [
		`Step ${s.step.id} passed: ${s.step.goal}`,
		`Check: ${check}`,
		`Used: ${s.tokens} tokens, $${Math.round(s.cost_usd * 10_000) / 10_000}`,
		s.next ? `Next: ${s.next.id}: ${s.next.goal}` : "Next: none; the plan has no pending step",
	].join("\n");
}

/** `/run-plan [n]`: the number of steps to start, or null for all pending steps. */
export function parseRunPlanArgs(text: string): number | null {
	const t = text.trim();
	if (t === "") return null;
	if (!/^\d+$/.test(t) || Number(t) < 1) throw new CommandError(`usage: /run-plan [n], where n is a whole number of steps, 1 or more; got "${t}"`);
	return Number(t);
}
