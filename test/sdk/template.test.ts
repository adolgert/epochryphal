// Level 2: the README's walkthrough on a copy of the template harness/ directory, with the scripted
// model standing in for the agent: /plan-new, /step, a procedure and submit, /plan-status, the
// report; then /add-step twice and /run-plan with one boundary answered.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

const TEMPLATE_HARNESS = new URL("../../template/harness/", import.meta.url).pathname;
const REPORT = new URL("../../src/bin/harness-report.ts", import.meta.url).pathname;

let s: SdkSession | undefined;
let toy: ToyProject | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
	toy?.cleanup();
	toy = undefined;
});

/** A git repository whose harness/ is a copy of the template, committed. */
function templateProject(): ToyProject {
	const t = makeToyProject();
	rmSync(join(t.dir, "harness"), { recursive: true });
	cpSync(TEMPLATE_HARNESS, join(t.dir, "harness"), { recursive: true });
	t.git("add", "-A");
	t.git("-c", "user.name=toy", "-c", "user.email=toy@example.invalid", "commit", "-q", "-m", "add the harness template");
	return t;
}

const statuses = (t: ToyProject) => (t.readPlan("demo") as { steps: { id: string; status: string }[] }).steps.map((x) => `${x.id} ${x.status}`);

describe("the walkthrough on the template", () => {
	it("a supervised step: a procedure, submit, /plan-status, and harness-report", async () => {
		toy = templateProject();
		s = await runSdkSession({
			project: toy,
			script: [{ tool: "build", args: { variant: "cpu" } }, { tool: "run_sample" }, { tool: "submit", args: { note: "built and ran" } }],
			ui: { select: [] },
		});
		await s.prompt("/plan-new demo Try the harness on this project");
		await s.prompt("/step measure -- Build the cpu variant, run the sample, then submit.");
		await s.prompt("/plan-status");
		expect(s.notices[0]).toBe("Plan demo created and active.");
		expect(s.notices.at(-1)).toBe(["Plan demo: Try the harness on this project", "  s1 passed    measure: Build the cpu variant, run the sample, then submit."].join("\n"));
		expect(s.toolResults().map((r) => `${r.toolName} ${r.isError}`)).toEqual(["build false", "run_sample false", "submit false"]);
		expect(s.toolResults()[2]!.text).toBe(
			"The check passed: Stub check for kind measure: it passes every step. Replace harness/scripts/check with a real check.\nStep s1 passed. Stop here.",
		);
		expect(toy.readSteps()).toMatchObject([{ plan: "demo", step: "s1", kind: "measure", outcome: "passed", check_attempts: 1, tokens: 330, model_calls: 3 }]);
		const report = execFileSync(process.execPath, [REPORT, "--project", toy.dir], { encoding: "utf8" });
		expect(report).toContain("| measure | 1 | 1 | 0 | 0 | 0 | 100% | 100% | 330 | $0.00 |");
	});

	it("/run-plan runs two added steps, asking at the boundary", async () => {
		toy = templateProject();
		s = await runSdkSession({ project: toy, script: [{ tool: "submit" }, { tool: "submit" }], ui: { select: ["Continue"] } });
		await s.prompt("/plan-new demo Try the harness on this project");
		await s.prompt("/add-step measure -- Profile the sample workload.");
		await s.prompt("/add-step restructure -- Split the solver routine in two.");
		await s.prompt("/run-plan");
		expect(statuses(toy)).toEqual(["s1 passed", "s2 passed"]);
		expect(s.dialogs).toHaveLength(1);
		expect(s.dialogs[0]!.options).toEqual(["Continue", "Stop", "Stop and edit the plan"]);
		expect(s.dialogs[0]!.title).toMatch(/Start s2\?$/);
		expect(toy.readSteps().map((r) => r.mode)).toEqual(["run_plan", "run_plan"]);
	});
});
