// Level 1: the /run-plan boundary decision, the boundary summary, and the command's argument.
import { describe, expect, it } from "vitest";
import { type Approval, type BoundaryInput, boundarySummary, decideBoundary, parseRunPlanArgs } from "../../src/core/runplan.ts";

const input = (over: Partial<BoundaryInput> = {}): BoundaryInput => ({
	step: { id: "s1", status: "passed" },
	aborted: false,
	next: { id: "s2" },
	started: 1,
	limit: null,
	stopRequested: false,
	approval: "auto",
	...over,
});

describe("decideBoundary", () => {
	it("a passed step with a pending step continues with auto, asks with ask, and follows the answer", () => {
		const cases: [Approval, string][] = [
			["auto", "continue"],
			["ask", "ask"],
			["continue", "continue"],
			["stop", "stop"],
			["stop_edit", "stop"],
			["no_ui", "stop"],
		];
		for (const [approval, action] of cases) expect([approval, decideBoundary(input({ approval })).action]).toEqual([approval, action]);
		expect(decideBoundary(input({ approval: "stop_edit" }))).toEqual({ action: "stop", why: "you chose stop and edit", edit: true });
		expect(decideBoundary(input({ approval: "no_ui" }))).toMatchObject({ why: expect.stringMatching(/no user interface to ask in, so s2 was not started/) });
	});

	it("a passed step with no pending step is the end of the plan, whatever the approval", () => {
		for (const approval of ["auto", "ask", "continue", "no_ui"] as Approval[]) {
			expect(decideBoundary(input({ next: null, approval }))).toEqual({ action: "end", why: "the plan has no pending step left" });
		}
	});

	it("n steps started ends the mode before asking; fewer continues", () => {
		expect(decideBoundary(input({ started: 2, limit: 2, approval: "ask" }))).toEqual({ action: "end", why: "2 steps run, as asked" });
		expect(decideBoundary(input({ started: 1, limit: 1 }))).toEqual({ action: "end", why: "1 step run, as asked" });
		expect(decideBoundary(input({ started: 1, limit: 2 })).action).toBe("continue");
	});

	it("/stop-plan stops at a pass instead of continuing", () => {
		expect(decideBoundary(input({ stopRequested: true, approval: "continue" }))).toEqual({ action: "stop", why: "/stop-plan was given" });
	});

	it("every outcome other than passed stops, whatever the pending steps and the approval", () => {
		for (const status of ["blocked", "abandoned", "stopped", "active", "pending", "missing"] as const) {
			for (const approval of ["auto", "continue", "ask"] as Approval[]) {
				for (const next of [{ id: "s2" }, null]) {
					expect(decideBoundary(input({ step: { id: "s1", status }, approval, next })).action).toBe("stop");
				}
			}
		}
		expect(decideBoundary(input({ step: { id: "s1", status: "blocked", reason: "no GPU" } }))).toMatchObject({ why: "step s1 ended blocked: no GPU" });
		expect(decideBoundary(input({ step: { id: "s1", status: "active" } }))).toMatchObject({ why: expect.stringMatching(/^the agent stopped without calling submit or report_blocked; step s1 is still active/) });
	});

	it("an aborted run never continues, even when the step passed", () => {
		expect(decideBoundary(input({ aborted: true }))).toEqual({ action: "stop", why: "the run was aborted; step s1 is passed" });
		expect(decideBoundary(input({ aborted: true, step: { id: "s1", status: "stopped", reason: "stop rule stall: x" } }))).toMatchObject({ why: "step s1 ended stopped: stop rule stall: x" });
	});
});

describe("boundarySummary", () => {
	it("shows the goal, check summary, usage, and the next goal", () => {
		const text = boundarySummary({ step: { id: "s1", goal: "Profile" }, check: "all tests pass", tokens: 220, cost_usd: 0.00301, next: { id: "s2", goal: "Port R17" } });
		expect(text).toBe("Step s1 passed: Profile\nCheck: all tests pass\nUsed: 220 tokens, $0.003\nNext: s2: Port R17");
	});

	it("cuts a long check summary and says when there is no check or next step", () => {
		const text = boundarySummary({ step: { id: "s1", goal: "G" }, check: "x".repeat(400), tokens: 0, cost_usd: 0, next: null });
		expect(text).toContain(`Check: ${"x".repeat(300)}…\n`);
		expect(text).toMatch(/Next: none; the plan has no pending step$/);
		expect(boundarySummary({ step: { id: "s1", goal: "G" }, check: null, tokens: 0, cost_usd: 0, next: null })).toContain("Check: (no check summary in the log)");
	});
});

describe("parseRunPlanArgs", () => {
	it("accepts nothing (all steps) or a whole number of 1 or more", () => {
		expect(parseRunPlanArgs("")).toBeNull();
		expect(parseRunPlanArgs("  3 ")).toBe(3);
	});

	it("refuses zero, negatives, fractions, and words with a usage message", () => {
		for (const bad of ["0", "-1", "1.5", "two", "2 3"]) expect(() => parseRunPlanArgs(bad)).toThrow(/^usage: \/run-plan \[n\], where n is a whole number of steps, 1 or more/);
	});
});
