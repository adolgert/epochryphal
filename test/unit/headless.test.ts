// Level 1: the headless runner's loop for one step (core/headless.ts), driven by a fake session
// with scripted check results.
import { describe, expect, it } from "vitest";
import { type LoopCheck, type LoopSession, runStepLoop } from "../../src/core/headless.ts";
import { feedbackPrompt } from "../../src/core/prompt.ts";

interface Script {
	/** Whether the step is still active after each settle, in order. Default: true. */
	active?: boolean[];
	checks?: LoopCheck[];
	/** Prompt numbers (1, 2, ...) after which harness-ctl stop has been given. */
	stopAfterPrompt?: number;
}

const failed = (summary: string, ended = false, stopRule: string | null = null): LoopCheck => ({ status: "failed", summary, ended, stopRule });
const PASSED: LoopCheck = { status: "passed", summary: "all pass", ended: true, stopRule: null };

function fake(script: Script) {
	const prompts: string[] = [];
	const stops: { rule: string; value: number | null; limit: number | null }[] = [];
	let checks = 0;
	const session: LoopSession = {
		prompt: async (text) => void prompts.push(text),
		active: async () => script.active?.[prompts.length - 1] ?? true,
		check: async () => {
			const c = script.checks?.[checks++];
			if (!c) throw new Error("no scripted check result left");
			return c;
		},
		stop: async (rule, _why, value, limit) => void stops.push({ rule, value, limit }),
		stopRequested: () => script.stopAfterPrompt !== undefined && prompts.length >= script.stopAfterPrompt,
	};
	return { session, prompts, stops, checks: () => checks };
}

const STEP = { id: "s2", prompt: "[harness step s2 | ...]" };

describe("runStepLoop", () => {
	it("pass on first settle: one prompt, the runner's check passes", async () => {
		const f = fake({ checks: [PASSED] });
		expect(await runStepLoop(f.session, STEP, 3)).toEqual({ how: "passed" });
		expect(f.prompts).toEqual([STEP.prompt]);
		expect(f.stops).toEqual([]);
	});

	it("pass after one feedback prompt, which carries only the check summary", async () => {
		const f = fake({ checks: [failed("2 tests failed"), PASSED] });
		expect(await runStepLoop(f.session, STEP, 3)).toEqual({ how: "passed" });
		expect(f.prompts).toEqual([STEP.prompt, feedbackPrompt("s2", "2 tests failed")]);
		expect(f.prompts[1]).toBe("The check for step s2 did not pass:\n2 tests failed\nContinue working. Call `submit` when the step is complete, or `report_blocked` if you cannot proceed.");
	});

	it("max_iterations: after max prompts without a pass the step is stopped with that rule", async () => {
		const f = fake({ checks: [failed("a"), failed("b"), failed("c")] });
		expect(await runStepLoop(f.session, STEP, 3)).toEqual({ how: "stopped", rule: "max_iterations" });
		expect(f.prompts).toEqual([STEP.prompt, feedbackPrompt("s2", "a"), feedbackPrompt("s2", "b")]);
		expect(f.stops).toEqual([{ rule: "max_iterations", value: 3, limit: 3 }]);
	});

	it("stall: a check after which the session's stop rules ended the step leaves the loop with that rule", async () => {
		const f = fake({ checks: [failed("T1 fails"), failed("T1 fails", true, "stall")] });
		expect(await runStepLoop(f.session, STEP, 3)).toEqual({ how: "stopped", rule: "stall" });
		expect(f.prompts).toHaveLength(2);
		expect(f.stops).toEqual([]); // The session stopped it, not the loop.
	});

	it("blocked: the step is no longer active after the agent's run, so no check runs", async () => {
		const f = fake({ active: [false] });
		expect(await runStepLoop(f.session, STEP, 3)).toEqual({ how: "ended" });
		expect(f.prompts).toEqual([STEP.prompt]);
		expect(f.checks()).toBe(0);
		expect(f.stops).toEqual([]);
	});

	it("harness-ctl stop during the agent's run stops the active step with aborted_by_user, before any check", async () => {
		const f = fake({ stopAfterPrompt: 1 });
		expect(await runStepLoop(f.session, STEP, 3)).toEqual({ how: "stopped", rule: "aborted_by_user" });
		expect(f.checks()).toBe(0);
		expect(f.stops).toEqual([{ rule: "aborted_by_user", value: null, limit: null }]);
	});

	it("a stop that came while the step ended anyway leaves the ended step alone", async () => {
		const f = fake({ active: [false], stopAfterPrompt: 1 });
		expect(await runStepLoop(f.session, STEP, 3)).toEqual({ how: "ended" });
		expect(f.stops).toEqual([]);
	});

	it("a check that ended the step by check_error, and a broken check the session did not stop (fallback)", async () => {
		const stopped = fake({ checks: [{ status: "error", summary: "exit code 3", ended: true, stopRule: "check_error" }] });
		expect(await runStepLoop(stopped.session, STEP, 3)).toEqual({ how: "stopped", rule: "check_error" });
		expect(stopped.stops).toEqual([]);
		const fallback = fake({ checks: [{ status: "error", summary: "exit code 3", ended: false, stopRule: null }] });
		expect(await runStepLoop(fallback.session, STEP, 3)).toEqual({ how: "stopped", rule: "check_error" });
		expect(fallback.stops).toEqual([{ rule: "check_error", value: null, limit: null }]);
	});
});
