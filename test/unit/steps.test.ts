// Level 1: the step record of plan Section 5.4, assembled from the events of one attempt.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../src/core/log.ts";
import { appendStepRecord, interruptionsOf, stepRecord } from "../../src/core/steps.ts";

const ref = { plan: "e1", step: "s2", attempt: 2 };
let clock = Date.parse("2026-11-10T14:00:00Z");

/** An event of attempt `ref` (or of `other`), `minutes` after the previous one. */
function ev(minutes: number, type: string, fields: Record<string, unknown> = {}, other?: Partial<typeof ref>) {
	clock += minutes * 60_000;
	return { ts: new Date(clock).toISOString(), session: "x", mode: "supervised", ...ref, ...other, type, ...fields };
}
const model = (tokens: number, cost: number) => ({ total_tokens: tokens, cost_usd: cost, input: tokens - 10, output: 10 });
const interruption = (how: string, label?: { n: number; reason: string }) => ({
	how,
	text_head: label ? null : "msg",
	reason: label?.reason ?? null,
	note: null,
	label_of: label?.n ?? null,
});

function fixture() {
	clock = Date.parse("2026-11-10T14:00:00Z");
	return [
		ev(0, "session_start", { reason: "startup" }, { plan: null, step: null, attempt: null } as never),
		// Attempt 1 of the same step, which must not be counted.
		ev(0, "step_start", { kind: "offload", goal: "g", origin: "proposal:p1", commit: "c" }, { attempt: 1 }),
		ev(1, "model_call", model(999, 9), { attempt: 1 }),
		ev(0, "interruption", interruption("steer"), { attempt: 1 }),
		ev(1, "step_end", { outcome: "abandoned", detail: "x" }, { attempt: 1 }),
		// Attempt 2: starts at 14:02.
		ev(0, "step_start", { kind: "offload", goal: "g", origin: "proposal:p1", commit: "c" }),
		ev(1, "model_call", model(1000, 0.01)),
		ev(0, "tool_call", { tool: "build", parent: null, is_error: true }),
		ev(0, "script", { name: "build", is_wait: false, outcome: "result", ok: false, duration_ms: 30_000 }),
		ev(0, "interruption", interruption("steer")),
		ev(1, "model_call", model(2000, 0.02)),
		// A nested call: one script event, whichever tool made it.
		ev(0, "tool_call", { tool: "wait_for_job", parent: "call-1", is_error: false }),
		ev(0, "script", { name: "wait_for_job", is_wait: true, outcome: "result", ok: true, duration_ms: 6 * 60_000 }),
		ev(0, "script", { name: "run_sample", is_wait: false, outcome: "script_error", ok: null, duration_ms: 1000 }),
		ev(0, "script", { name: "run_sample", is_wait: false, outcome: "aborted", ok: null, duration_ms: 1000 }),
		ev(0, "interruption", interruption("abort")),
		ev(0, "interruption", interruption("abort", { n: 1, reason: "missing-info" })),
		ev(0, "interruption", interruption("abort", { n: 2, reason: "wrong-direction" })),
		ev(0, "interruption", interruption("abort", { n: 2, reason: "too-slow" })), // The latest label wins.
		ev(0, "interruption", interruption("idle_message")),
		ev(1, "check", { outcome: "result", ok: false, signature: "protected_changed" }),
		ev(0, "check", { outcome: "script_error", ok: null }),
		ev(5, "session_end", { reason: "quit" }),
		ev(1, "model_call", model(3000, 0.03)),
		ev(1, "check", { outcome: "result", ok: true }),
		ev(0, "step_end", { outcome: "passed", detail: "note from submit" }),
		// Ends at 14:12: 10 minutes of wall-clock time.
		ev(1, "model_call", model(5, 5), { plan: null, step: null, attempt: null } as never),
	];
}

describe("step record", () => {
	it("counts interruptions by reason, check attempts, script failures, tokens, cost, and minutes", () => {
		expect(stepRecord(fixture(), ref)).toEqual({
			ts: "2026-11-10T14:12:00.000Z",
			plan: "e1",
			step: "s2",
			attempt: 2,
			kind: "offload",
			origin: "proposal:p1",
			mode: "supervised",
			outcome: "passed",
			stop_rule: null,
			reason: null,
			interruptions: 3,
			interruptions_by_reason: { "missing-info": 1, "too-slow": 1, unlabeled: 1 },
			check_attempts: 2,
			script_failures: 2,
			tokens: 6000,
			cost_usd: 0.06,
			agent_minutes: 4,
			wait_minutes: 6,
			model_calls: 3,
		});
	});

	it("keeps the reason of a step that did not pass and takes the mode from step_start", () => {
		clock = 0;
		const events = [ev(0, "step_start", { kind: "measure", origin: "user", mode: "run_plan" }), ev(2.5, "step_end", { outcome: "blocked", detail: "no profiler" })];
		expect(stepRecord(events, ref)).toMatchObject({ mode: "run_plan", outcome: "blocked", reason: "no profiler", interruptions: 0, interruptions_by_reason: {}, agent_minutes: 2.5, wait_minutes: 0 });
	});

	it("is null when the attempt has not both started and ended", () => {
		const events = fixture();
		expect(stepRecord(events.filter((e) => e.type !== "step_end"), ref)).toBeNull();
		expect(stepRecord(events, { ...ref, attempt: 3 })).toBeNull();
	});

	it("numbers interruptions and ignores a label of an interruption that does not exist", () => {
		expect(interruptionsOf([{ type: "interruption", how: "steer", label_of: null }, { type: "interruption", how: "steer", label_of: 5, reason: "other" }])).toEqual([
			{ n: 1, how: "steer", reason: null },
		]);
	});

	it("appendStepRecord appends one line built from the event log", () => {
		const dir = mkdtempSync(join(tmpdir(), "steps-"));
		try {
			const events = join(dir, "events.jsonl");
			writeFileSync(events, fixture().map((e) => JSON.stringify(e)).join("\n") + "\n");
			appendStepRecord(events, join(dir, "log/steps.jsonl"), ref);
			appendStepRecord(events, join(dir, "log/steps.jsonl"), { ...ref, attempt: 1 });
			expect(readEvents(join(dir, "log/steps.jsonl")).map((r) => [r.attempt, r.outcome])).toEqual([
				[2, "passed"],
				[1, "abandoned"],
			]);
			expect(() => appendStepRecord(events, join(dir, "log/steps.jsonl"), { ...ref, attempt: 9 })).toThrow(/no step_start and step_end for e1 s2 attempt 9/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
