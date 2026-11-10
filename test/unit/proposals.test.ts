// Level 1: proposal transitions (plan Sections 5.2 and 7.3), the /proposals text, and the report's
// per-plan counts for plans changed by those transitions.
import { describe, expect, it } from "vitest";
import {
	acceptProposal,
	addProposal,
	addStep,
	closePlan,
	MAX_OPEN_PROPOSALS,
	newPlan,
	type NewProposal,
	type Plan,
	planProblems,
	rejectProposal,
	startStep,
} from "../../src/core/plan.ts";
import { formatReport } from "../../src/core/report.ts";
import { formatProposals } from "../../src/core/status.ts";
import type { StepRecord } from "../../src/core/steps.ts";

const T = new Date("2026-11-10T14:02:11Z");
const spec: NewProposal = { kind: "offload", goal: " Keep R17 arrays on the device. ", check_args: ["R17"], rationale: " Repeated copies. ", proposed_in_step: "s1" };

/** A plan with `n` open proposals p1..pn. */
function withProposals(n: number): Plan {
	let plan = newPlan("e1", "g", T);
	for (let i = 0; i < n; i++) plan = addProposal(plan, { ...spec, goal: `goal ${i + 1}` }).plan;
	return plan;
}

describe("addProposal", () => {
	it("stores an open proposal with trimmed text and id p1", () => {
		const { plan, proposal } = addProposal(newPlan("e1", "g", T), spec);
		expect(proposal).toEqual({
			id: "p1",
			kind: "offload",
			goal: "Keep R17 arrays on the device.",
			check_args: ["R17"],
			rationale: "Repeated copies.",
			proposed_in_step: "s1",
			state: "open",
		});
		expect(plan.proposals).toEqual([proposal]);
		expect(plan.steps).toEqual([]);
		expect(planProblems(plan)).toEqual([]);
	});

	it("allows proposed_in_step null and no check arguments", () => {
		const { proposal } = addProposal(newPlan("e1", "g", T), { kind: "measure", goal: "g", rationale: "r", proposed_in_step: null });
		expect(proposal).toMatchObject({ check_args: [], proposed_in_step: null });
	});

	it("continues ids from the highest number in the file", () => {
		const plan = withProposals(2);
		const edited = { ...plan, proposals: [{ ...plan.proposals[0]!, id: "p7" }] };
		expect(addProposal(edited, spec).proposal.id).toBe("p8");
		expect(addProposal(plan, spec).proposal.id).toBe("p3");
	});

	it("refuses an empty goal or rationale, and a closed plan", () => {
		const plan = newPlan("e1", "g", T);
		expect(() => addProposal(plan, { ...spec, goal: " " })).toThrow("the proposal needs a goal");
		expect(() => addProposal(plan, { ...spec, rationale: "" })).toThrow(/the proposal needs a rationale/);
		expect(() => addProposal(closePlan(plan, "keep", "done", T), spec)).toThrow(/plan e1 is closed \(keep\)/);
	});

	it("refuses the eleventh open proposal; accepted and rejected ones do not count", () => {
		const ten = withProposals(MAX_OPEN_PROPOSALS);
		expect(MAX_OPEN_PROPOSALS).toBe(10);
		expect(() => addProposal(ten, spec)).toThrow("plan e1 already has 10 open proposals, the most allowed; a person must accept or reject some first");
		const fewer = acceptProposal(rejectProposal(ten, "p1"), "p2").plan;
		expect(addProposal(addProposal(fewer, spec).plan, spec).proposal.id).toBe("p12");
		expect(() => addProposal(addProposal(addProposal(fewer, spec).plan, spec).plan, spec)).toThrow(/10 open proposals/);
	});
});

describe("acceptProposal", () => {
	it("creates a pending step whose origin names the proposal, and marks the proposal accepted", () => {
		const base = addStep(newPlan("e1", "g", T), { kind: "measure", goal: "m" }).plan;
		const { plan, step } = acceptProposal(addProposal(base, spec).plan, "p1");
		expect(step).toEqual({ id: "s2", kind: "offload", goal: "Keep R17 arrays on the device.", check_args: ["R17"], origin: "proposal:p1", status: "pending", attempt: 1 });
		expect(plan.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(plan.proposals[0]!.state).toBe("accepted");
		expect(planProblems(plan)).toEqual([]);
	});

	it("can be done while a step is active; the new step stays pending", () => {
		const base = startStep(addStep(newPlan("e1", "g", T), { kind: "measure", goal: "m" }).plan, "s1");
		const { plan } = acceptProposal(addProposal(base, spec).plan, "p1");
		expect(plan.steps.map((s) => s.status)).toEqual(["active", "pending"]);
	});

	it("cannot be done twice, after a rejection, for an unknown id, or on a closed plan", () => {
		const plan = withProposals(1);
		const accepted = acceptProposal(plan, "p1").plan;
		expect(() => acceptProposal(accepted, "p1")).toThrow("proposal p1 is already accepted");
		expect(() => acceptProposal(rejectProposal(plan, "p1"), "p1")).toThrow("proposal p1 is already rejected");
		expect(() => acceptProposal(plan, "p9")).toThrow("plan e1 has no proposal p9; /proposals lists the open ones");
		expect(() => acceptProposal(closePlan(plan, "keep", "done", T), "p1")).toThrow(/closed/);
	});
});

describe("rejectProposal", () => {
	it("records the reason when one is given, and no reason field otherwise", () => {
		const plan = withProposals(2);
		const rejected = rejectProposal(rejectProposal(plan, "p1", "  not now  "), "p2");
		expect(rejected.proposals.map((p) => [p.state, p.reason])).toEqual([
			["rejected", "not now"],
			["rejected", undefined],
		]);
		expect("reason" in rejected.proposals[1]!).toBe(false);
		expect(rejected.steps).toEqual([]);
		expect(planProblems(rejected)).toEqual([]);
	});

	it("cannot be done twice, after an acceptance, or on a closed plan", () => {
		const plan = withProposals(1);
		expect(() => rejectProposal(rejectProposal(plan, "p1", "a"), "p1", "b")).toThrow("proposal p1 is already rejected");
		expect(() => rejectProposal(acceptProposal(plan, "p1").plan, "p1")).toThrow("proposal p1 is already accepted");
		expect(() => rejectProposal(closePlan(plan, "keep", "done", T), "p1")).toThrow(/closed/);
	});
});

describe("plan file checks", () => {
	it("report a proposal id used twice", () => {
		const plan = withProposals(2);
		const bad = { ...plan, proposals: [plan.proposals[0]!, { ...plan.proposals[1]!, id: "p1" }] };
		expect(planProblems(bad)).toEqual(['proposals[1].id "p1" is used twice']);
	});
});

describe("formatProposals", () => {
	it("lists only open proposals with their rationale and where they came from", () => {
		let plan = addProposal(withProposals(2), { kind: "measure", goal: "Profile again", rationale: "Things changed", proposed_in_step: null }).plan;
		plan = rejectProposal(plan, "p2");
		expect(formatProposals(plan)).toBe(
			[
				"Open proposals in plan e1:",
				"  p1 offload [R17]: goal 1",
				"     why: Repeated copies. (proposed in s1)",
				"  p3 measure: Profile again",
				"     why: Things changed (proposed in no step)",
				"Accept with /accept-step <id> [start], or reject with /reject-step <id> [reason].",
			].join("\n"),
		);
	});

	it("says so when there are none", () => {
		expect(formatProposals(newPlan("e1", "g", T))).toBe("Plan e1 has no open proposals.");
	});
});

describe("report per-plan counts", () => {
	it("agree with plans changed by the proposal transitions", () => {
		let plan = addStep(withProposals(3), { kind: "measure", goal: "user step" }).plan;
		plan = acceptProposal(plan, "p1").plan;
		plan = rejectProposal(plan, "p2", "no");
		const record: StepRecord = {
			ts: "2026-11-10T15:00:00.000Z",
			plan: "e1",
			step: "s1",
			attempt: 1,
			kind: "measure",
			origin: "user",
			mode: "supervised",
			outcome: "passed",
			stop_rule: null,
			reason: null,
			interruptions: 0,
			interruptions_by_reason: {},
			check_attempts: 1,
			script_failures: 0,
			tokens: 100,
			cost_usd: 1,
			agent_minutes: 1,
			wait_minutes: 0,
			model_calls: 1,
		};
		// steps 2, from proposals 1, accepted 1, rejected 1 (p3 is still open), plan still open.
		expect(formatReport([record], new Map([["e1", plan]]))).toContain("| e1 | 2 | 1 | 1 | 1 | open |");
	});
});
