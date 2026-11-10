// The stop rules of plan Section 7.7, as one pure function of a step's tracker and budget.
import { agentMs, type Tracker } from "./budget.ts";
import type { Budget } from "./config.ts";

/**
 * Every rule name. check_error, max_iterations, plan_changed_externally, and aborted_by_user
 * (harness-ctl stop) are for headless runs; trippedRules does not decide them.
 */
export type RuleName =
	| "budget_tokens"
	| "budget_cost"
	| "budget_minutes"
	| "max_check_attempts"
	| "stall"
	| "check_error"
	| "max_iterations"
	| "plan_changed_externally"
	| "aborted_by_user";

/** The rules only a headless run trips. They always stop: with nobody present, a warning helps no one. */
export type HeadlessRule = "check_error" | "max_iterations" | "plan_changed_externally" | "aborted_by_user";

export interface Trip {
	rule: RuleName;
	/** The measured quantity and its limit; null for stall. */
	value: number | null;
	limit: number | null;
	/** What happened, in words for the person and the agent. */
	why: string;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * The rules that hold at time `nowMs`, in this order: budget_tokens, budget_cost, budget_minutes
 * (over the budget), max_check_attempts (failed checks reach the budget), stall (the last two failed
 * checks have the same non-empty signature, or the same working tree). It returns every rule that
 * holds; the caller skips rules already tripped in the attempt.
 */
export function trippedRules(t: Tracker, budget: Budget, nowMs: number): Trip[] {
	const trips: Trip[] = [];
	if (t.tokens > budget.tokens) {
		trips.push({ rule: "budget_tokens", value: t.tokens, limit: budget.tokens, why: `${t.tokens} tokens used, budget ${budget.tokens}` });
	}
	if (t.cost_usd > budget.cost_usd) {
		const cost = round(t.cost_usd, 4);
		trips.push({ rule: "budget_cost", value: cost, limit: budget.cost_usd, why: `$${cost} spent, budget $${budget.cost_usd}` });
	}
	const minutes = agentMs(t, nowMs) / 60_000;
	if (minutes > budget.agent_minutes) {
		const m = round(minutes, 2);
		trips.push({ rule: "budget_minutes", value: m, limit: budget.agent_minutes, why: `${m} agent minutes used, budget ${budget.agent_minutes}` });
	}
	const failed = t.failed_checks.length;
	if (failed >= budget.check_attempts) {
		trips.push({ rule: "max_check_attempts", value: failed, limit: budget.check_attempts, why: `${failed} failed checks, budget ${budget.check_attempts}` });
	}
	const [a, b] = t.failed_checks.slice(-2);
	if (a && b) {
		if (a.signature && a.signature === b.signature) {
			trips.push({ rule: "stall", value: null, limit: null, why: `the last two checks failed with the same signature ${a.signature}` });
		} else if (a.tree !== null && a.tree === b.tree) {
			trips.push({ rule: "stall", value: null, limit: null, why: "the working tree did not change between the last two failed checks" });
		}
	}
	return trips;
}
