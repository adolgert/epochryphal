// Level 1 (stub): submit, report_blocked, the edit/write guard, and the git checks at step start.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { FakeClock } from "../rig/clock.ts";
import { type ContextOptions, FakePi } from "../rig/fake-pi.ts";
import { type Behavior, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

async function session(t: ToyProject, sessionId = "sess-1") {
	const pi = new FakePi().load(createHarnessExtension({ clock: new FakeClock() }));
	const opts: ContextOptions = { cwd: t.dir, sessionId };
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, opts);
	const run = async (line: string, extra: ContextOptions = {}) => {
		const [name, ...rest] = line.replace(/^\//, "").split(" ");
		await pi.runCommand(name!, rest.join(" "), { ...opts, ...extra });
	};
	const tool = (name: string, params: unknown, extra: ContextOptions = {}) => pi.callTool(name, params, { ...opts, ...extra });
	const guard = async (toolName: string, path: string, cwd = t.dir) =>
		(await pi.fire("tool_call", { type: "tool_call", toolCallId: "c1", toolName, input: { path, content: "x", edits: [] } }, { ...opts, cwd }))[0] as
			| { block: boolean; reason: string }
			| undefined;
	return { pi, run, tool, guard };
}

/** A toy project with plan e1 and step s1 (offload R17) active. */
async function withActiveStep(behavior: Behavior = {}) {
	toy = makeToyProject({ behavior });
	const s = await session(toy);
	await s.run("/plan-new e1 Goal");
	await s.run("/step offload R17 -- Port R17");
	return s;
}

async function sections(pi: FakePi): Promise<Record<string, string>> {
	const event = { type: "before_agent_start", systemPromptOptions: { sections: {} as Record<string, string> } };
	await pi.fire("before_agent_start", event);
	return event.systemPromptOptions.sections;
}

const errors = (pi: FakePi) => pi.notifications.filter((n) => n.type === "error").map((n) => n.message);
const commitAll = (t: ToyProject) => {
	t.git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A");
	t.git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "change");
};

describe("completion tools", () => {
	it("registers submit and report_blocked as sequential tools", async () => {
		const pi = new FakePi().load(createHarnessExtension());
		expect(pi.tools.get("submit")?.executionMode).toBe("sequential");
		expect(pi.tools.get("report_blocked")?.executionMode).toBe("sequential");
	});

	it("submit that passes ends the step, ends the run, and clears the active-step line", async () => {
		const { pi, run, tool } = await withActiveStep({ check: [{ ok: true, summary: "all tests pass" }] });
		const result = await tool("submit", { note: "ported R17" });
		expect(result).toMatchObject({ terminate: true });
		expect(result.isError).toBeFalsy();
		expect(pi.textOf(result)).toBe("The check passed: all tests pass\nStep s1 passed. Stop here.");
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ id: "s1", status: "passed" }] });
		expect(toy!.readEvents().slice(-2)).toEqual([
			expect.objectContaining({ type: "check", step: "s1", ok: true, by: "submit" }),
			expect.objectContaining({ type: "step_end", step: "s1", outcome: "passed", detail: "ported R17" }),
		]);
		expect(await sections(pi)).toEqual({});
		// The plan was written through the store, so its hash is known: no dialog next time.
		await run("/add-step measure -- Next");
		expect(pi.dialogs).toEqual([]);
		expect(errors(pi)).toEqual([]);
	});

	it("submit that fails returns the summary as an error and leaves the step active", async () => {
		const { pi, tool } = await withActiveStep({ check: [{ ok: false, summary: "2 tests failed", signature: "T1,T2" }] });
		const result = await tool("submit", {});
		expect(result).toMatchObject({ isError: true });
		expect(result.terminate).toBeFalsy();
		expect(pi.textOf(result)).toMatch(/2 tests failed/);
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
		expect((await sections(pi)).harness).toMatch(/^Active harness step s1/);
	});

	it("report_blocked ends the step as blocked with the reason, ends the run, and clears the line", async () => {
		const { pi, tool } = await withActiveStep();
		expect(pi.textOf(await tool("report_blocked", { reason: "   " }))).toMatch(/needs a reason/);
		const result = await tool("report_blocked", { reason: "the compiler is missing" });
		expect(result).toMatchObject({ terminate: true });
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ status: "blocked", reason: "the compiler is missing" }] });
		expect(toy!.readEvents().at(-1)).toMatchObject({ type: "step_end", step: "s1", outcome: "blocked", detail: "the compiler is missing" });
		expect(await sections(pi)).toEqual({});
	});

	it("both tools refuse when no step is active, and change nothing", async () => {
		toy = makeToyProject();
		const { pi, run, tool } = await session(toy);
		for (const name of ["submit", "report_blocked"]) {
			const result = await tool(name, { reason: "r" });
			expect(result).toMatchObject({ isError: true });
			expect(pi.textOf(result)).toMatch(/no active plan/);
		}
		await run("/plan-new e1 Goal");
		const events = toy.readEvents().length;
		for (const name of ["submit", "report_blocked"]) {
			expect(pi.textOf(await tool(name, { reason: "r" }))).toBe(`No harness step is active, so ${name} has nothing to act on. Nothing was changed.`);
		}
		expect(toy.readEvents()).toHaveLength(events);
		expect(toy.scriptCalls()).toEqual([]);
	});

	it("submit asks before using a plan edited by hand; refused, it runs no check", async () => {
		const { pi, tool } = await withActiveStep();
		const path = join(toy!.dir, "harness/plans/e1.json");
		const plan = toy!.readPlan("e1") as { goal: string };
		writeFileSync(path, JSON.stringify({ ...plan, goal: "edited" }));
		const result = await tool("submit", {}, { ui: { confirm: [false] } });
		expect(pi.textOf(result)).toMatch(/was not accepted; nothing was done/);
		expect(pi.dialogs).toHaveLength(1);
		expect(toy!.scriptCalls()).toEqual([]);
	});
});

describe("git at step start and submit", () => {
	it("records the current commit in step_start", async () => {
		await withActiveStep();
		expect(toy!.readEvents().find((e) => e.type === "step_start")).toMatchObject({ commit: toy!.git("rev-parse", "HEAD") });
	});

	it("a restored step uses the commit from the log, so a committed change to a test still fails submit", async () => {
		await withActiveStep();
		writeFileSync(join(toy!.dir, "tests/test_solver.txt"), "expect nothing\n");
		commitAll(toy!);
		const second = await session(toy!, "sess-2");
		const result = await second.tool("submit", {});
		expect(second.pi.textOf(result)).toMatch(/protected files changed: tests\/test_solver.txt/);
		expect(toy!.readEvents().at(-1)).toMatchObject({ type: "check", session: "sess-2", signature: "protected_changed" });
	});

	it("a restored step with no step_start in the log warns, and submit reports an error instead of passing", async () => {
		await withActiveStep();
		rmSync(join(toy!.dir, "harness/log/events.jsonl"));
		const second = await session(toy!, "sess-2");
		expect(second.pi.notifications).toEqual([expect.objectContaining({ type: "warning", message: expect.stringMatching(/the log has no commit for when it started/) })]);
		const result = await second.tool("submit", {});
		expect(second.pi.textOf(result)).toMatch(/no commit was recorded when step s1 started/);
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
		expect(toy!.scriptCalls()).toEqual([]);
	});

	it("refuses to start a step while protected files have uncommitted changes, and says which", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/add-step measure -- Profile");
		writeFileSync(join(toy.dir, "tests/test_solver.txt"), "changed\n");
		writeFileSync(join(toy.dir, "harness/scripts/new"), "new\n");
		writeFileSync(join(toy.dir, "src/solver.txt"), "unprotected changes are fine\n");
		await run("/next-step");
		await run("/step measure -- Another");
		expect(errors(pi)).toEqual([
			expect.stringMatching(/protected files have uncommitted changes: harness\/scripts\/new, tests\/test_solver.txt; commit or restore them/),
			expect.stringMatching(/protected files have uncommitted changes/),
		]);
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ status: "pending" }] });
		expect(toy.readEvents().filter((e) => e.type === "step_start")).toEqual([]);
		expect(pi.sentUserMessages).toEqual([]);
	});

	it("refuses to start a step when the project is not a git repository, or git is missing", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/add-step measure -- Profile");
		const path = process.env.PATH;
		process.env.PATH = join(toy.workDir, "empty");
		try {
			await run("/next-step");
		} finally {
			process.env.PATH = path;
		}
		rmSync(join(toy.dir, ".git"), { recursive: true });
		await run("/next-step");
		expect(errors(pi)).toEqual([
			expect.stringMatching(/git is not installed or not on the PATH/),
			expect.stringMatching(/needs the project to be a git repository with at least one commit/),
		]);
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ status: "pending" }] });
		expect(pi.sentUserMessages).toEqual([]);
	});

	it("submit reports an error, not a failure, when git has gone away", async () => {
		const { pi, tool } = await withActiveStep();
		rmSync(join(toy!.dir, ".git"), { recursive: true });
		const result = await tool("submit", {});
		expect(pi.textOf(result)).toMatch(/The check itself is broken.*the protected-file check could not run/s);
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
	});
});

describe("edit and write guard", () => {
	it("blocks protected files, plan files, and the log, and writes guard_block", async () => {
		toy = makeToyProject();
		const { guard } = await session(toy);
		expect(await guard("write", "tests/test_solver.txt")).toEqual({
			block: true,
			reason: "tests/test_solver.txt must not be changed by the agent: it matches the protected pattern tests/**. Leave it as it is; if the step needs it changed, call report_blocked and say why.",
		});
		expect(await guard("edit", "@harness/plans/e1.json")).toMatchObject({ block: true });
		expect(await guard("edit", "../harness/log/events.jsonl", join(toy.dir, "src"))).toMatchObject({ block: true });
		expect(await guard("write", join(toy.dir, "harness/harness.json"))).toMatchObject({ block: true });
		expect(toy.readEvents().filter((e) => e.type === "guard_block").map((e) => [e.tool, e.path])).toEqual([
			["write", "tests/test_solver.txt"],
			["edit", "harness/plans/e1.json"],
			["edit", "harness/log/events.jsonl"],
			["write", "harness/harness.json"],
		]);
	});

	it("allows other files, other tools, and paths outside the project", async () => {
		toy = makeToyProject();
		const { guard } = await session(toy);
		expect(await guard("write", "src/solver.txt")).toBeUndefined();
		expect(await guard("read", "tests/test_solver.txt")).toBeUndefined();
		expect(await guard("write", join(toy.workDir, "x.txt"))).toBeUndefined();
		expect(toy.readEvents().filter((e) => e.type === "guard_block")).toEqual([]);
	});

	it("protects the whole harness directory when harness.json cannot be read", async () => {
		toy = makeToyProject();
		const { guard } = await session(toy);
		writeFileSync(join(toy.dir, "harness/harness.json"), "{ not json");
		expect(await guard("write", "harness/notes.md")).toMatchObject({ block: true });
		expect(await guard("write", "tests/test_solver.txt")).toBeUndefined();
	});
});
