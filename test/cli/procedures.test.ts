// Level 3: procedure tools appear when pi loads the extension from a path.
import { afterEach, describe, expect, it } from "vitest";
import { runPiCli } from "../rig/cli.ts";
import { defaultConfig, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

describe("procedure tools from the pi executable", () => {
	it("the model's tool list has one tool per procedure, named as in the toy configuration, and calling one runs its script", async () => {
		const procs = defaultConfig().procedures as Record<string, unknown>[];
		toy = makeToyProject({ config: { procedures: [...procs, { ...procs[0], name: "profile_run", description: "Profile a run.", params: {} }] } });
		const r = await runPiCli({ project: toy, script: [{ tool: "profile_run", args: {} }, { text: "done" }], prompt: "Profile." });
		expect(r.exitCode).toBe(0);
		expect(r.requests()[0]!.tools).toEqual(expect.arrayContaining(["build", "run_sample", "wait_for_job", "profile_run"]));
		const end = r.events.find((e) => e.type === "tool_execution_end");
		expect(end).toMatchObject({ toolName: "profile_run", isError: false });
		expect(toy.readEvents().filter((e) => e.type === "script")).toEqual([expect.objectContaining({ name: "profile_run", ok: true })]);
	});
});
