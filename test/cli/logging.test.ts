// Level 3: the pi executable writes the event log into the project.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPiCli } from "../rig/cli.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

describe("event log from the pi executable", () => {
	it("writes harness/log/events.jsonl with session_start first and session_end last", async () => {
		toy = makeToyProject();
		const r = await runPiCli({ project: toy, script: [{ tool: "harness_ping", args: {} }, { text: "done" }], prompt: "hello" });
		expect(r.exitCode).toBe(0);
		const events = toy.readEvents();
		expect(events[0]).toMatchObject({ type: "session_start", reason: "startup" });
		expect(events.filter((e) => e.type === "tool_call").map((e) => e.tool)).toEqual(["harness_ping"]);
		expect(events.at(-1)).toMatchObject({ type: "session_end", reason: "quit" });
		expect(toy.git("status", "--porcelain")).toBe("");
	});

	it("writes nothing in a directory with no harness.json above it, and warns on standard error", async () => {
		toy = makeToyProject();
		const elsewhere = join(toy.workDir, "elsewhere");
		mkdirSync(elsewhere);
		const r = await runPiCli({ project: toy, cwd: elsewhere, script: [{ text: "done" }], prompt: "hello" });
		expect(r.exitCode).toBe(0);
		expect(existsSync(join(elsewhere, "harness"))).toBe(false);
		expect(r.stderr).toMatch(/harness inactive/);
	});
});
