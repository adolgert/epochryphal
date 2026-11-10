// The budget tracker of one step attempt (plan Section 7.7). It is a fold over the attempt's events,
// so the live tracker (fed each record as it is written) and one rebuilt from events.jsonl after a
// restart are the same by construction. The step record (steps.ts) uses it too.
import type { RuleAction } from "./config.ts";
import type { StepRef } from "./log.ts";

type Event = Record<string, unknown>;

export interface Tracker {
	ref: StepRef;
	/** Time of the attempt's step_start, in milliseconds; null until it is seen. */
	start_ms: number | null;
	tokens: number;
	cost_usd: number;
	model_calls: number;
	/** Time spent inside procedures marked is_wait. */
	wait_ms: number;
	/** Script events with ok false or a script error; aborted scripts do not count. */
	script_failures: number;
	/** Check events with a result. A broken check (script_error) is not an attempt; protected_changed is. */
	check_attempts: number;
	/** The failed checks, oldest first, with their signature and working-tree fingerprint. */
	failed_checks: { signature: string | null; tree: string | null }[];
	/** Rules tripped in this attempt, from rule_tripped events. */
	tripped: { rule: string; action: RuleAction }[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Whether an event (or another reference) belongs to step attempt `a`. */
export const sameAttempt = (a: StepRef, e: { plan?: unknown; step?: unknown; attempt?: unknown }): boolean =>
	e.plan === a.plan && e.step === a.step && e.attempt === a.attempt;

export function newTracker(ref: StepRef): Tracker {
	return { ref: { plan: ref.plan, step: ref.step, attempt: ref.attempt }, start_ms: null, tokens: 0, cost_usd: 0, model_calls: 0, wait_ms: 0, script_failures: 0, check_attempts: 0, failed_checks: [], tripped: [] };
}

/** Add one event to the tracker, in place. Events of other attempts are ignored. */
export function track(t: Tracker, e: Event): void {
	if (!sameAttempt(t.ref, e)) return;
	switch (e.type) {
		case "step_start": {
			const ms = Date.parse(String(e.ts));
			if (t.start_ms === null && Number.isFinite(ms)) t.start_ms = ms;
			break;
		}
		case "model_call":
			t.tokens += num(e.total_tokens);
			t.cost_usd += num(e.cost_usd);
			t.model_calls++;
			break;
		case "script":
			if (e.is_wait === true) t.wait_ms += num(e.duration_ms);
			if (e.ok === false || e.outcome === "script_error") t.script_failures++;
			break;
		case "check":
			if (e.outcome !== "result") break;
			t.check_attempts++;
			if (e.ok === false) t.failed_checks.push({ signature: str(e.signature), tree: str(e.tree) });
			break;
		case "rule_tripped":
			if (e.action === "warn" || e.action === "stop") t.tripped.push({ rule: String(e.rule), action: e.action });
			break;
	}
}

/** The tracker of one attempt, rebuilt from the event log. */
export function rebuildTracker(events: readonly Event[], ref: StepRef): Tracker {
	const t = newTracker(ref);
	for (const e of events) track(t, e);
	return t;
}

/**
 * Agent time until `endMs`: wall-clock time since step_start minus time inside is_wait procedures.
 * As the plan defines it, this includes time while pi was closed and time the agent sat idle
 * waiting for the person, as long as the step stayed active.
 */
export function agentMs(t: Tracker, endMs: number): number {
	if (t.start_ms === null || !Number.isFinite(endMs)) return 0;
	return Math.max(0, endMs - t.start_ms - t.wait_ms);
}

/** Usage against a budget, as /plan-status shows it and the rules compare it. */
export interface Usage {
	tokens: number;
	cost_usd: number;
	agent_minutes: number;
	check_attempts: number;
}

export function usageOf(t: Tracker, nowMs: number): Usage {
	return { tokens: t.tokens, cost_usd: t.cost_usd, agent_minutes: agentMs(t, nowMs) / 60_000, check_attempts: t.check_attempts };
}
