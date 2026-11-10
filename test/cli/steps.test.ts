// Level 3: plan commands given as the prompt to the pi executable.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPiCli } from "../rig/cli.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

describe("plan commands from the pi executable", () => {
	it("/plan-new given as the prompt creates the plan file and makes it active", async () => {
		toy = makeToyProject();
		const r = await runPiCli({ project: toy, script: [], prompt: "/plan-new e1 Some goal" });
		expect(r.exitCode).toBe(0);
		expect(toy.readPlan("e1")).toMatchObject({ plan_id: "e1", goal: "Some goal", steps: [] });
		expect(readFileSync(join(toy.dir, "harness/plans/ACTIVE"), "utf8")).toBe("e1\n");
		expect(r.requests()).toHaveLength(0);
	});
});
