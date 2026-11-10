// Level 3: the pi executable as a subprocess, loading the extension from a path.
import { afterEach, describe, expect, it } from "vitest";
import { runPiCli } from "../rig/cli.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

describe("pi executable", () => {
	it("loads the extension with -e; the model's harness_ping call shows in the JSON events; exit 0", async () => {
		toy = makeToyProject();
		const r = await runPiCli({
			project: toy,
			script: [{ tool: "harness_ping", args: {} }, { text: "done" }],
			prompt: "hello",
		});
		expect(r.exitCode).toBe(0);
		const starts = r.events.filter((e) => e.type === "tool_execution_start");
		expect(starts.map((e) => e.toolName)).toEqual(["harness_ping"]);
		const ends = r.events.filter((e) => e.type === "tool_execution_end");
		expect(ends.map((e) => e.isError)).toEqual([false]);
	});

	it("with --no-extensions and no -e for the extension, harness_ping is absent", async () => {
		toy = makeToyProject();
		const r = await runPiCli({
			project: toy,
			script: [{ text: "done" }],
			prompt: "hello",
			loadExtension: false,
		});
		expect(r.exitCode).toBe(0);
		expect(r.requests()[0]!.tools).not.toContain("harness_ping");
		expect(r.requests()[0]!.tools).toContain("read");
	});
});
