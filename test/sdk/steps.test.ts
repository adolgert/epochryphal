// Level 2: steps in a real pi session. The first test is the drift test for before_agent_start.
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../rig/script.ts";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let s: SdkSession | undefined;
let toy: ToyProject | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
	toy?.cleanup();
	toy = undefined;
});

/** Text of the user messages in a request. */
function userTexts(request: ModelRequest): string[] {
	return request.messages
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("")));
}

describe("steps in a real session", () => {
	it("[drift] before_agent_start: the step prompt is a user message and the active-step line is in the system prompt", async () => {
		s = await runSdkSession({ script: [{ text: "working on it" }] });
		await s.prompt("/plan-new e1 Run the solve on the GPU");
		await s.prompt("/step measure -- Profile it");
		const [request] = s.requests();
		expect(request).toBeDefined();
		expect(userTexts(request!)).toEqual([
			[
				"[harness step s1 | kind: measure | plan: e1]",
				"Epoch goal: Run the solve on the GPU",
				"Step goal: Profile it",
				"You are finished only when the `submit` tool passes. If you cannot proceed, call",
				"`report_blocked` with the reason. Do not change files under: harness/harness.json, harness/scripts/**, harness/lessons/**, tests/**.",
			].join("\n"),
		]);
		expect(request!.system).toContain("Active harness step s1: Profile it. Finish with submit or report_blocked.");
	});

	it("has no active-step line when no step is active", async () => {
		s = await runSdkSession({ script: [{ text: "hi" }] });
		await s.prompt("hello");
		expect(s.requests()[0]!.system).not.toContain("Active harness step");
	});

	it("/abandon sets the status and writes step_end with outcome abandoned", async () => {
		s = await runSdkSession({ script: [{ text: "working on it" }] });
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("/step measure -- Profile it");
		await s.prompt("/abandon too slow");
		expect(s.project.readPlan("e1")).toMatchObject({ steps: [{ id: "s1", status: "abandoned", reason: "too slow" }] });
		expect(s.project.readEvents().filter((e) => e.type === "step_end")).toEqual([
			expect.objectContaining({ plan: "e1", step: "s1", attempt: 1, outcome: "abandoned", detail: "too slow" }),
		]);
	});

	it("a new session on the same project with an active step shows the active-step line again", async () => {
		toy = makeToyProject();
		s = await runSdkSession({ project: toy, script: [{ text: "working on it" }] });
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("/step offload R17 -- Port R17");
		await s.dispose();
		s = await runSdkSession({ project: toy, script: [{ text: "resuming" }] });
		await s.prompt("Where were we?");
		expect(s.requests()[0]!.system).toContain("Active harness step s1: Port R17. Finish with submit or report_blocked.");
	});
});
