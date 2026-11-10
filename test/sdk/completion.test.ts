// Level 2: submit, report_blocked, and the guard in a real pi session with the scripted model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptEntry } from "../rig/script.ts";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";
import { type Behavior, makeToyProject } from "../rig/toy-project.ts";

let s: SdkSession | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
});

/** A session with plan e1, in which `/step measure -- Profile it` runs `script`. */
async function stepWith(script: ScriptEntry[], behavior: Behavior = {}): Promise<SdkSession> {
	s = await runSdkSession({ project: makeToyProject({ behavior }), script });
	await s.prompt("/plan-new e1 Goal");
	await s.prompt("/step measure -- Profile it");
	return s;
}

const ofType = (session: SdkSession, type: string) => session.project.readEvents().filter((e) => e.type === type);
/** Every text the model was shown in a request's messages. */
const shown = (session: SdkSession, i: number) => JSON.stringify(session.requests()[i]?.messages ?? []);

describe("completion tools in a real session", () => {
	it("[drift] submit that passes: status passed, step_end passed, and the run ends without another model call", async () => {
		const t = await stepWith([{ tool: "submit", args: {} }, { text: "done" }], { check: [{ ok: true, summary: "profile recorded" }] });
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ id: "s1", status: "passed" }] });
		expect(ofType(t, "step_end")).toEqual([expect.objectContaining({ step: "s1", outcome: "passed" })]);
		expect(t.requests()).toHaveLength(1);
		expect(t.toolResults()).toEqual([expect.objectContaining({ toolName: "submit", isError: false, text: expect.stringMatching(/The check passed: profile recorded/) })]);
	});

	it("submit fails, then passes: two check events, the failure summary reaches the model, final status passed", async () => {
		const t = await stepWith([{ tool: "submit", args: {} }, { tool: "submit", args: {} }, { text: "done" }], {
			check: [{ ok: false, summary: "2 tests failed", signature: "T1,T2" }, { ok: true, summary: "all tests pass" }],
		});
		expect(ofType(t, "check").map((e) => [e.ok, e.signature])).toEqual([
			[false, "T1,T2"],
			[true, null],
		]);
		expect(shown(t, 1)).toContain("2 tests failed");
		expect(t.requests()).toHaveLength(2);
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "passed" }] });
	});

	it("report_blocked: status blocked with the reason recorded", async () => {
		const t = await stepWith([{ tool: "report_blocked", args: { reason: "no profiler on this machine" } }, { text: "stopped" }]);
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "blocked", reason: "no profiler on this machine" }] });
		expect(ofType(t, "step_end")).toEqual([expect.objectContaining({ outcome: "blocked", detail: "no profiler on this machine" })]);
		expect(t.requests()).toHaveLength(1);
	});

	it("[drift] tool_call: an edit to a protected file is blocked, the file is unchanged, and guard_block is logged", async () => {
		const t = await stepWith([{ tool: "edit", args: { path: "tests/test_solver.txt", edits: [{ oldText: "expect", newText: "hope" }] } }, { text: "ok" }]);
		expect(readFileSync(join(t.project.dir, "tests/test_solver.txt"), "utf8")).toBe("expect residual below 1e-12\n");
		expect(ofType(t, "guard_block")).toEqual([expect.objectContaining({ tool: "edit", path: "tests/test_solver.txt", step: "s1" })]);
		expect(t.toolResults()).toEqual([expect.objectContaining({ toolName: "edit", isError: true, text: expect.stringMatching(/protected pattern tests\/\*\*/) })]);
	});

	it("a shell command that overwrites a protected file makes submit fail with protected_changed, listing the file", async () => {
		const t = await stepWith(
			[{ tool: "bash", args: { command: "echo 'expect anything' > tests/test_solver.txt" } }, { tool: "submit", args: {} }, { text: "hmm" }],
			{ check: [{ ok: true, summary: "all tests pass" }] },
		);
		expect(readFileSync(join(t.project.dir, "tests/test_solver.txt"), "utf8")).toBe("expect anything\n");
		expect(ofType(t, "check")).toEqual([expect.objectContaining({ ok: false, signature: "protected_changed" })]);
		expect(t.toolResults().at(-1)).toMatchObject({ toolName: "submit", isError: true, text: expect.stringMatching(/protected files changed: tests\/test_solver.txt/) });
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
		expect(t.project.scriptCalls()).toEqual([]);
	});

	it("submit with no active step returns a refusal and changes nothing", async () => {
		s = await runSdkSession({ script: [{ tool: "submit", args: {} }, { text: "ok" }] });
		await s.prompt("/plan-new e1 Goal");
		const plan = readFileSync(join(s.project.dir, "harness/plans/e1.json"), "utf8");
		await s.prompt("Submit, please.");
		expect(s.toolResults()).toEqual([expect.objectContaining({ toolName: "submit", isError: true, text: expect.stringMatching(/No harness step is active/) })]);
		expect(readFileSync(join(s.project.dir, "harness/plans/e1.json"), "utf8")).toBe(plan);
		expect(ofType(s, "check")).toEqual([]);
		expect(s.project.scriptCalls()).toEqual([]);
	});

	it("a broken check script makes submit tell the agent to call report_blocked, and is not a check attempt", async () => {
		const t = await stepWith([{ tool: "submit", args: {} }, { text: "will report" }], { check: [{ mode: "exit", code: 3 }] });
		expect(t.toolResults()).toEqual([expect.objectContaining({ toolName: "submit", isError: true, text: expect.stringMatching(/check itself is broken[\s\S]*Call report_blocked/) })]);
		// Check attempts are check events with a result; a script error is not one.
		expect(ofType(t, "check")).toEqual([expect.objectContaining({ outcome: "script_error", ok: null })]);
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "active", attempt: 1 }] });
	});

	it("after submit passes, the next run's system prompt has no active-step line", async () => {
		const t = await stepWith([{ tool: "submit", args: {} }, { text: "next" }]);
		await t.prompt("What now?");
		expect(t.requests()).toHaveLength(2);
		expect(t.requests()[0]!.system).toContain("Active harness step s1");
		expect(t.requests()[1]!.system).not.toContain("Active harness step");
	});
});
