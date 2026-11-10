// Level 2: propose_step and /accept-step in a real pi session with the scripted model.
import { afterEach, describe, expect, it } from "vitest";
import type { Plan } from "../../src/core/plan.ts";
import type { ModelRequest } from "../rig/script.ts";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";

let s: SdkSession | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
});

const proposal = { kind: "offload", goal: "Keep R17 on the device", check_args: ["R17"], rationale: "The profile shows repeated copies." };

function userTexts(request: ModelRequest): string[] {
	return request.messages
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("")));
}

describe("proposals in a real session", () => {
	it("[propose_step, text]: one open proposal, no new step, and the run goes on to the next model call", async () => {
		s = await runSdkSession({ script: [{ tool: "propose_step", args: proposal }, { text: "carrying on" }] });
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("/step measure -- Profile it");
		const plan = s.project.readPlan("e1") as Plan;
		expect(plan.steps).toEqual([expect.objectContaining({ id: "s1", status: "active" })]);
		expect(plan.proposals).toEqual([{ id: "p1", ...proposal, proposed_in_step: "s1", state: "open" }]);
		expect(s.toolResults()).toEqual([{ toolName: "propose_step", isError: false, text: expect.stringMatching(/^Recorded proposal p1\./) }]);
		expect(s.requests()).toHaveLength(2);
		expect(s.project.readEvents().filter((e) => e.type === "proposal")).toEqual([expect.objectContaining({ proposal_id: "p1", action: "proposed", step: "s1" })]);
	});

	it("/accept-step p1 start creates and starts the step, and the model receives the step template", async () => {
		s = await runSdkSession({ script: [{ tool: "propose_step", args: proposal }, { text: "proposed" }, { text: "working on it" }] });
		await s.prompt("/plan-new e1 Run the solve on the GPU");
		await s.prompt("What should come next?");
		expect((s.project.readPlan("e1") as Plan).proposals).toEqual([expect.objectContaining({ id: "p1", proposed_in_step: null, state: "open" })]);
		await s.prompt("/accept-step p1 start");
		expect(s.project.readPlan("e1")).toMatchObject({
			steps: [{ id: "s1", kind: "offload", check_args: ["R17"], origin: "proposal:p1", status: "active" }],
			proposals: [{ id: "p1", state: "accepted" }],
		});
		const request = s.requests()[2];
		expect(userTexts(request!).at(-1)).toBe(
			[
				"[harness step s1 | kind: offload | plan: e1]",
				"Epoch goal: Run the solve on the GPU",
				"Step goal: Keep R17 on the device",
				"You are finished only when the `submit` tool passes. If you cannot proceed, call",
				"`report_blocked` with the reason. Do not change files under: harness/harness.json, harness/scripts/**, harness/lessons/**, tests/**.",
			].join("\n"),
		);
		expect(request!.system).toContain("Active harness step s1: Keep R17 on the device.");
	});

	it("propose_step with an unknown kind returns a refusal that lists the known kinds", async () => {
		s = await runSdkSession({ script: [{ tool: "propose_step", args: { ...proposal, kind: "vectorize" } }, { text: "ok" }] });
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("Suggest something");
		expect(s.toolResults()).toEqual([
			{ toolName: "propose_step", isError: true, text: 'Unknown kind "vectorize". Known kinds: restructure, offload, measure. Nothing was recorded.' },
		]);
		expect(JSON.stringify(s.requests()[1]!.messages)).toContain("Known kinds: restructure, offload, measure");
		expect((s.project.readPlan("e1") as Plan).proposals).toEqual([]);
	});
});
