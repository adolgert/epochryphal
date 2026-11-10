// The step record, harness/log/steps.jsonl (plan Section 5.4): one line per finished step attempt,
// assembled only from that attempt's events in events.jsonl, so it can always be rebuilt from disk.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { agentMs, rebuildTracker } from "./budget.ts";
import { type Mode, readEvents, type StepRef } from "./log.ts";
import type { StepOutcome } from "./plan.ts";

type Event = Record<string, unknown>;

/** Reasons /why accepts. An interruption without one counts as "unlabeled". */
export const INTERRUPTION_REASONS = ["wrong-direction", "missing-info", "environment", "too-slow", "other"];

export interface StepRecord {
	ts: string;
	plan: string;
	step: string;
	attempt: number;
	kind: string;
	origin: string;
	mode: Mode;
	outcome: StepOutcome;
	/** The rule that stopped the step; null unless the outcome is stopped. */
	stop_rule: string | null;
	/** The reason given for blocked, abandoned, or stopped; null for passed. */
	reason: string | null;
	interruptions: number;
	interruptions_by_reason: Record<string, number>;
	check_attempts: number;
	script_failures: number;
	tokens: number;
	cost_usd: number;
	agent_minutes: number;
	wait_minutes: number;
	model_calls: number;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** The events of one step attempt, oldest first. */
export function attemptEvents(events: readonly Event[], ref: StepRef): Event[] {
	return events.filter((e) => e.plan === ref.plan && e.step === ref.step && e.attempt === ref.attempt);
}

/**
 * Interruptions of one attempt, numbered 1, 2, ... in order, each with the reason of its latest
 * /why label, or null when unlabeled.
 */
export function interruptionsOf(events: readonly Event[]): { n: number; how: string; reason: string | null }[] {
	const list: { n: number; how: string; reason: string | null }[] = [];
	for (const e of events) {
		if (e.type !== "interruption") continue;
		if (typeof e.label_of === "number") {
			const target = list[e.label_of - 1];
			if (target && typeof e.reason === "string") target.reason = e.reason;
		} else {
			list.push({ n: list.length + 1, how: String(e.how), reason: null });
		}
	}
	return list;
}

/**
 * The step record of one attempt, or null when the log has no step_start and step_end for it.
 *
 * Tokens, cost, model calls, check attempts, script failures, and wait time are the budget
 * tracker's (budget.ts), so the record and the stop rules count the same way. Counts come from
 * check, script, and model_call events, one per execution, so a call that another tool made
 * (tool_call with a parent) is neither missed nor counted twice. agent_minutes is wall-clock time
 * from step_start to step_end, minus wait_minutes. stop_rule is the first rule_tripped with action stop.
 */
export function stepRecord(events: readonly Event[], ref: StepRef): StepRecord | null {
	const own = attemptEvents(events, ref);
	const start = own.find((e) => e.type === "step_start");
	const end = own.findLast((e) => e.type === "step_end");
	if (!start || !end) return null;
	const byReason: Record<string, number> = {};
	const interruptions = interruptionsOf(own);
	for (const i of interruptions) {
		const reason = i.reason ?? "unlabeled";
		byReason[reason] = (byReason[reason] ?? 0) + 1;
	}
	const t = rebuildTracker(own, ref);
	const outcome = end.outcome as StepOutcome;
	return {
		ts: String(end.ts),
		...ref,
		kind: String(start.kind),
		origin: String(start.origin),
		mode: start.mode as Mode,
		outcome,
		stop_rule: outcome === "stopped" ? (t.tripped.find((r) => r.action === "stop")?.rule ?? null) : null,
		reason: outcome === "passed" || typeof end.detail !== "string" ? null : end.detail,
		interruptions: interruptions.length,
		interruptions_by_reason: byReason,
		check_attempts: t.check_attempts,
		script_failures: t.script_failures,
		tokens: t.tokens,
		cost_usd: round(t.cost_usd, 6),
		agent_minutes: round(agentMs(t, Date.parse(String(end.ts))) / 60_000, 2),
		wait_minutes: round(t.wait_ms / 60_000, 2),
		model_calls: t.model_calls,
	};
}

/** Build the record of one attempt from the event log and append it to the step log. Throws on I/O errors. */
export function appendStepRecord(eventsPath: string, stepsPath: string, ref: StepRef): StepRecord {
	const record = stepRecord(readEvents(eventsPath), ref);
	if (!record) throw new Error(`the event log has no step_start and step_end for ${ref.plan} ${ref.step} attempt ${ref.attempt}`);
	mkdirSync(dirname(stepsPath), { recursive: true });
	appendFileSync(stepsPath, JSON.stringify(record) + "\n");
	return record;
}
