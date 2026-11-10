// Level 1: plan transitions and the plan store (plan Section 5.2).
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	activeStep,
	addStep,
	closePlan,
	endStep,
	firstPending,
	newPlan,
	type Plan,
	PlanError,
	PlanStore,
	planProblems,
	retryStep,
	startStep,
	type StepStatus,
} from "../../src/core/plan.ts";
import { planDifference } from "../../src/core/status.ts";
import { activeStepLine, stepPrompt } from "../../src/core/prompt.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

const T = new Date("2026-11-10T14:02:11Z");

/** A plan with steps s1..sN, each with the given status. */
function planWith(...statuses: StepStatus[]): Plan {
	let plan = newPlan("e1", "Run the solve on the GPU.", T);
	for (const status of statuses) {
		const added = addStep(plan, { kind: "measure", goal: `goal ${plan.steps.length + 1}` });
		plan = { ...added.plan, steps: added.plan.steps.map((s) => (s.id === added.step.id ? { ...s, status } : s)) };
	}
	return plan;
}

const statusOf = (plan: Plan) => plan.steps.map((s) => s.status);

describe("newPlan", () => {
	it("creates an open plan with no steps", () => {
		expect(newPlan("epoch-12.tridiag_offload", "  Port the solver.  ", T)).toEqual({
			plan_id: "epoch-12.tridiag_offload",
			goal: "Port the solver.",
			created_at: "2026-11-10T14:02:11.000Z",
			steps: [],
			proposals: [],
			exit: null,
		});
	});

	it("refuses a plan id that is not a safe file name, and an empty goal", () => {
		expect(() => newPlan("../e1", "g", T)).toThrow(/plan id/);
		expect(() => newPlan("e1", "  ", T)).toThrow(/needs a goal/);
	});
});

describe("step ids", () => {
	it("are s1, s2, ... in order", () => {
		const plan = planWith("passed", "pending");
		expect(addStep(plan, { kind: "measure", goal: "g" }).step.id).toBe("s3");
		expect(plan.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
	});

	it("continue after the highest id even when steps were removed by hand", () => {
		const plan = planWith("passed", "passed", "passed");
		const edited = { ...plan, steps: plan.steps.filter((s) => s.id !== "s2") };
		expect(addStep(edited, { kind: "measure", goal: "g" }).step.id).toBe("s4");
	});

	it("start each new step pending, attempt 1, origin user, with its check arguments", () => {
		const { step } = addStep(newPlan("e1", "g", T), { kind: "offload", goal: " Port R17 ", check_args: ["R17"] });
		expect(step).toEqual({ id: "s1", kind: "offload", goal: "Port R17", check_args: ["R17"], origin: "user", status: "pending", attempt: 1 });
	});
});

describe("status transitions", () => {
	it("pending -> active", () => {
		expect(statusOf(startStep(planWith("passed", "pending"), "s2"))).toEqual(["passed", "active"]);
	});

	it("active -> passed, blocked, abandoned, stopped; the last three keep a reason", () => {
		for (const outcome of ["passed", "blocked", "abandoned", "stopped"] as const) {
			const plan = endStep(planWith("active"), "s1", outcome, "a reason");
			expect(plan.steps[0]!.status).toBe(outcome);
			expect(plan.steps[0]!.reason).toBe(outcome === "passed" ? undefined : "a reason");
		}
	});

	it("blocked, abandoned, stopped -> active with the attempt raised by one", () => {
		for (const status of ["blocked", "abandoned", "stopped"] as const) {
			const { plan, step } = retryStep(planWith("passed", status), "s2");
			expect(step).toMatchObject({ id: "s2", status: "active", attempt: 2 });
			expect(statusOf(plan)).toEqual(["passed", "active"]);
		}
	});

	it("retry without an id picks the latest retryable step and drops its old reason", () => {
		let plan = endStep(planWith("active"), "s1", "blocked", "no GPU");
		plan = { ...plan, steps: [...plan.steps, ...planWith("passed", "stopped").steps.slice(1)] };
		const { step } = retryStep(plan);
		expect(step.id).toBe("s2");
		expect(retryStep(endStep(planWith("active"), "s1", "blocked", "no GPU")).step.reason).toBeUndefined();
	});

	it("refuses to start a step while another is active", () => {
		expect(() => startStep(planWith("active", "pending"), "s2")).toThrow("step s1 is active; finish it or /abandon it first");
		expect(() => retryStep(planWith("active", "blocked"), "s2")).toThrow(/step s1 is active/);
	});

	it("refuses illegal transitions with a message naming the status", () => {
		expect(() => startStep(planWith("passed"), "s1")).toThrow("step s1 is passed, not pending");
		expect(() => endStep(planWith("pending"), "s1", "passed")).toThrow("step s1 is pending, not active");
		expect(() => retryStep(planWith("passed"), "s1")).toThrow(/s1 is passed; only a blocked, abandoned, or stopped step/);
		expect(() => retryStep(planWith("passed"))).toThrow("no step is blocked, abandoned, or stopped");
		expect(() => startStep(planWith("pending"), "s9")).toThrow("plan e1 has no step s9");
	});

	it("requires a reason for every ending except passed", () => {
		expect(() => endStep(planWith("active"), "s1", "abandoned", " ")).toThrow("a abandoned step needs a reason");
	});

	it("finds the active and the first pending step", () => {
		const plan = planWith("passed", "active", "pending", "pending");
		expect(activeStep(plan)?.id).toBe("s2");
		expect(firstPending(plan)?.id).toBe("s3");
	});
});

describe("closePlan", () => {
	it("records the decision, note, and time", () => {
		expect(closePlan(planWith("passed"), "revert", "slower on the GPU", T).exit).toEqual({
			decision: "revert",
			note: "slower on the GPU",
			at: "2026-11-10T14:02:11.000Z",
		});
	});

	it("is refused while a step is active, and a closed plan takes no new steps", () => {
		expect(() => closePlan(planWith("active"), "keep", "n", T)).toThrow(/step s1 is active/);
		const closed = closePlan(planWith("passed", "pending"), "keep", "done", T);
		expect(() => addStep(closed, { kind: "measure", goal: "g" })).toThrow(/closed \(keep\)/);
		expect(() => startStep(closed, "s2")).toThrow(/closed/);
		expect(() => closePlan(closed, "keep", "again", T)).toThrow(/closed/);
	});
});

describe("planProblems", () => {
	it("accepts a valid plan and reports problems in a hand-edited one", () => {
		expect(planProblems(planWith("passed", "active"))).toEqual([]);
		const bad = planWith("active", "active") as any;
		bad.steps[1].id = "s1";
		bad.steps[0].status = "done";
		expect(planProblems(bad)).toEqual([
			"steps[0].status must be one of pending, active, passed, blocked, abandoned, stopped",
			'steps[1].id "s1" is used twice',
		]);
		expect(planProblems(planWith("active", "active"))).toEqual(["2 steps are active; at most one may be"]);
	});

	const proposal = { id: "p1", kind: "measure", goal: "g", check_args: ["R1"], rationale: "r", proposed_in_step: "s1", state: "open" };

	it("accepts valid proposals, an optional reason, and a null proposed_in_step", () => {
		const plan = { ...planWith(), proposals: [proposal, { ...proposal, id: "p2", proposed_in_step: null, state: "rejected", reason: "no" }] };
		expect(planProblems(plan)).toEqual([]);
	});

	it("reports problems inside proposals", () => {
		expect(planProblems({ ...planWith(), proposals: [null] })).toEqual(["proposals[0] must be an object"]);
		const bad = { id: 1, kind: null, rationale: 2, check_args: [3], proposed_in_step: 4, state: "maybe", reason: 5 };
		expect(planProblems({ ...planWith(), proposals: [proposal, bad] })).toEqual([
			"proposals[1].id must be a string",
			"proposals[1].kind must be a string",
			"proposals[1].goal must be a string",
			"proposals[1].rationale must be a string",
			"proposals[1].check_args must be a list of strings",
			"proposals[1].proposed_in_step must be a string or null",
			"proposals[1].state must be one of open, accepted, rejected",
			"proposals[1].reason must be a string",
		]);
	});

	it("checks the exit record when the plan is closed", () => {
		expect(planProblems(closePlan(planWith("passed"), "keep", "done", T))).toEqual([]);
		expect(planProblems({ ...planWith(), exit: {} })).toEqual([
			"exit.decision must be one of keep, revert, continue",
			"exit.note must be a string",
			"exit.at must be a string",
		]);
		expect(planProblems({ ...planWith(), exit: [] })).toEqual(["exit must be null or an object"]);
	});

	it("checks a step's optional reason and budget", () => {
		const plan = planWith("blocked", "pending", "pending") as any;
		plan.steps[0].reason = "no GPU";
		plan.steps[1].budget = { tokens: 5, cost_usd: 1.5 };
		expect(planProblems(plan)).toEqual([]);
		plan.steps[0].reason = 7;
		plan.steps[1].budget = { tokens: "many" };
		plan.steps[2].budget = [];
		expect(planProblems(plan)).toEqual([
			"steps[0].reason must be a string",
			"steps[1].budget.tokens must be a number",
			"steps[2].budget must be an object",
		]);
	});
});

describe("PlanStore", () => {
	it("creates, reads, and writes plans; refuses to create one that exists", () => {
		toy = makeToyProject();
		const store = new PlanStore(toy.dir);
		store.create(newPlan("e1", "g", T));
		expect(toy.readPlan("e1")).toMatchObject({ plan_id: "e1", steps: [] });
		const { plan } = addStep(store.read("e1").plan, { kind: "measure", goal: "g" });
		store.write(plan);
		expect(new PlanStore(toy.dir).read("e1").plan.steps).toHaveLength(1);
		expect(() => store.create(newPlan("e1", "g", T))).toThrow("plan e1 already exists; use /plan-use e1");
	});

	it("keeps the active plan id in plans/ACTIVE", () => {
		toy = makeToyProject();
		const store = new PlanStore(toy.dir);
		expect(store.activeId()).toBeNull();
		store.create(newPlan("e1", "g", T));
		store.setActive("e1");
		expect(readFileSync(`${store.dir}/ACTIVE`, "utf8")).toBe("e1\n");
		expect(new PlanStore(toy.dir).activeId()).toBe("e1");
		expect(() => store.setActive("e2")).toThrow(/no plan e2/);
	});

	it("detects a plan file changed on disk between two reads, and accepts it when told to", () => {
		toy = makeToyProject();
		const store = new PlanStore(toy.dir);
		store.create(newPlan("e1", "g", T));
		expect(store.read("e1").changedExternally).toBe(false);
		const path = store.pathOf("e1");
		writeFileSync(path, readFileSync(path, "utf8").replace('"goal": "g"', '"goal": "edited by hand"'));
		const second = store.read("e1");
		expect(second).toMatchObject({ changedExternally: true, plan: { goal: "edited by hand" } });
		store.accept("e1", second.hash);
		expect(store.read("e1").changedExternally).toBe(false);
	});

	it("returns the plan as last written or accepted, to show what a hand edit changed", () => {
		toy = makeToyProject();
		const store = new PlanStore(toy.dir);
		const written = addStep(addStep(newPlan("e1", "g", T), { kind: "measure", goal: "one" }).plan, { kind: "measure", goal: "two" }).plan;
		store.create(written);
		const edited = { ...written, steps: [{ ...written.steps[0]!, status: "active" }, ...written.steps.slice(1), { ...written.steps[0]!, id: "s3" }] };
		writeFileSync(store.pathOf("e1"), JSON.stringify(edited));
		const read = store.read("e1");
		expect(read.previous).toEqual(written);
		expect(planDifference(read.previous, read.plan)).toBe("steps: 2 -> 3; s1: pending -> active; s3 added (pending)");
		store.accept("e1", read.hash);
		writeFileSync(store.pathOf("e1"), JSON.stringify({ ...edited, goal: "other" }));
		const again = store.read("e1");
		expect(again.previous).toEqual(edited);
		expect(planDifference(again.previous, again.plan)).toBe("same steps and statuses; other fields changed");
		expect(planDifference(undefined, again.plan)).toBe("the plan now has 3 steps");
	});

	it("accepts the text that read returned, not a later change on disk", () => {
		toy = makeToyProject();
		const store = new PlanStore(toy.dir);
		store.create(newPlan("e1", "g", T));
		const path = store.pathOf("e1");
		writeFileSync(path, readFileSync(path, "utf8").replace('"goal": "g"', '"goal": "first edit"'));
		const seen = store.read("e1");
		writeFileSync(path, readFileSync(path, "utf8").replace('"goal": "first edit"', '"goal": "second edit"'));
		store.accept("e1", seen.hash);
		expect(store.read("e1")).toMatchObject({ changedExternally: true, plan: { goal: "second edit" } });
	});

	it("does not flag its own writes, and accepts the first read of a plan as known", () => {
		toy = makeToyProject();
		new PlanStore(toy.dir).create(newPlan("e1", "g", T));
		const store = new PlanStore(toy.dir);
		expect(store.read("e1").changedExternally).toBe(false);
		store.write(addStep(store.read("e1").plan, { kind: "measure", goal: "g" }).plan);
		expect(store.read("e1").changedExternally).toBe(false);
	});

	it("reports a plan file that is not JSON or not a valid plan", () => {
		toy = makeToyProject();
		const store = new PlanStore(toy.dir);
		store.create(newPlan("e1", "g", T));
		writeFileSync(store.pathOf("e1"), "{");
		expect(() => store.read("e1")).toThrow(/plan e1 is not valid JSON/);
		writeFileSync(store.pathOf("e1"), JSON.stringify({ plan_id: "e1" }));
		expect(() => store.read("e1")).toThrow(/plan e1 is not valid:\n {2}- goal must be a string/);
	});

	it("refuses plan ids that would leave the plans directory", () => {
		toy = makeToyProject();
		expect(new PlanStore(toy.dir).exists("../harness")).toBe(false);
	});
});

describe("step prompt", () => {
	it("follows the fixed template", () => {
		const plan = startStep(addStep(newPlan("e12", "Keep arrays on the device.", T), { kind: "offload", goal: "Port R17." }).plan, "s1");
		expect(stepPrompt(plan, plan.steps[0]!, ["tests/**", "harness/scripts/**"])).toBe(
			[
				"[harness step s1 | kind: offload | plan: e12]",
				"Epoch goal: Keep arrays on the device.",
				"Step goal: Port R17.",
				"You are finished only when the `submit` tool passes. If you cannot proceed, call",
				"`report_blocked` with the reason. Do not change files under: tests/**, harness/scripts/**.",
			].join("\n"),
		);
		expect(activeStepLine(plan.steps[0]!)).toBe("Active harness step s1: Port R17. Finish with submit or report_blocked.");
		expect(activeStepLine({ id: "s2", goal: "Profile it" })).toBe("Active harness step s2: Profile it. Finish with submit or report_blocked.");
	});

	it("says (none) when nothing is protected", () => {
		const plan = addStep(newPlan("e1", "g", T), { kind: "measure", goal: "m" }).plan;
		expect(stepPrompt(plan, plan.steps[0]!, [])).toMatch(/Do not change files under: \(none\)\.$/);
	});
});

it("PlanError is an Error with its own name", () => {
	expect(new PlanError("x")).toBeInstanceOf(Error);
	expect(new PlanError("x").name).toBe("PlanError");
});
