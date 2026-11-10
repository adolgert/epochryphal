// Level 1: procedure tools. The parameter schema, and the adapter against the stub of pi's API:
// registration at session_start, the requires rule, script events, and name clashes.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { procedureSchema } from "../../src/extension/procedures.ts";
import { FakeClock } from "../rig/clock.ts";
import { type ContextOptions, FakePi } from "../rig/fake-pi.ts";
import { type Behavior, defaultConfig, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function toyProject(behavior: Behavior = {}, config?: Record<string, unknown>): ToyProject {
	const t = makeToyProject({ behavior, config });
	cleanups.push(t.cleanup);
	return t;
}

const PROCEDURES = ["build", "run_sample", "wait_for_job"];

/** A stub pi with the harness loaded, after session_start in `t`. */
async function session(t: ToyProject, pi = new FakePi()) {
	if (pi.tools.size === 0) pi.load(createHarnessExtension({ clock: new FakeClock() }));
	const opts: ContextOptions = { cwd: t.dir };
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, opts);
	const run = async (line: string) => {
		const [name, ...rest] = line.replace(/^\//, "").split(" ");
		await pi.runCommand(name!, rest.join(" "), opts);
	};
	const tool = async (name: string, params: unknown = {}) => {
		const r = await pi.callTool(name, params, opts);
		return { isError: r.isError === true, text: pi.textOf(r) };
	};
	/** pi's built-in edit or write finished; durationMs is absent when it did not run. */
	const edited = (toolName: string, durationMs?: number, parentToolCallId?: string) =>
		pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "e1", toolName, result: {}, isError: durationMs === undefined, durationMs, parentToolCallId }, opts);
	return { pi, run, tool, edited };
}

const scripts = (t: ToyProject) => t.readEvents().filter((e) => e.type === "script");

describe("procedureSchema", () => {
	it("builds string, number, integer, boolean, and enumerated parameters, all required", () => {
		const schema = procedureSchema({
			name: { type: "string", description: "A name." },
			ratio: { type: "number" },
			count: { type: "integer", description: "How many." },
			fast: { type: "boolean" },
			variant: { type: "string", enum: ["cpu", "gpu"], description: "Which build." },
		});
		expect(JSON.parse(JSON.stringify(schema))).toEqual({
			type: "object",
			required: ["name", "ratio", "count", "fast", "variant"],
			properties: {
				name: { type: "string", description: "A name." },
				ratio: { type: "number" },
				count: { type: "integer", description: "How many." },
				fast: { type: "boolean" },
				variant: { type: "string", enum: ["cpu", "gpu"], description: "Which build." },
			},
		});
	});

	it("a procedure with no parameters takes an empty object", () => {
		expect(JSON.parse(JSON.stringify(procedureSchema({})))).toEqual({ type: "object", properties: {} });
	});
});

describe("procedure tools", () => {
	it("registers one sequential tool per procedure at session_start, with the configured description and schema", async () => {
		const pi = new FakePi().load(createHarnessExtension());
		expect(pi.toolNames()).not.toContain("build"); // The project is not known at load time.
		await session(toyProject(), pi);
		for (const name of PROCEDURES) expect(pi.tools.get(name)?.executionMode).toBe("sequential");
		expect(pi.tools.get("build")?.description).toBe("Build the code.");
		expect(pi.tools.get("build")?.parameters).toMatchObject({ required: ["variant"], properties: { variant: { enum: ["cpu", "gpu"] } } });
		expect(pi.notifications).toEqual([]);
	});

	it("runs the script with the configured parameters only, and writes a script event with is_wait", async () => {
		const t = toyProject({ wait_for_job: [{ ok: true, summary: "job 7 finished" }] });
		const { tool } = await session(t);
		expect(await tool("wait_for_job", { job_id: "7", extra: "dropped" })).toEqual({ isError: false, text: "job 7 finished" });
		expect(t.scriptCalls()).toEqual([expect.objectContaining({ name: "wait_for_job", stdin: { params: { job_id: "7" }, plan: null, step: null, attempt: null, kind: null } })]);
		expect(scripts(t)).toEqual([
			expect.objectContaining({ name: "wait_for_job", step: null, is_wait: true, outcome: "result", ok: true, signature: null, timed_out: false, output_path: expect.stringMatching(/^harness\/log\/outputs\/.*wait_for_job\.txt$/) }),
		]);
	});

	it("passes the active step to the script, and its events carry the step", async () => {
		const t = toyProject();
		const { run, tool } = await session(t);
		await run("/plan-new e1 Goal");
		await run("/step offload R17 -- Port R17");
		await tool("build", { variant: "gpu" });
		expect(t.scriptCalls().at(-1)).toMatchObject({ name: "build", stdin: { params: { variant: "gpu" }, plan: "e1", step: "s1", attempt: 1, kind: "offload" } });
		expect(scripts(t)).toEqual([expect.objectContaining({ name: "build", step: "s1", attempt: 1, is_wait: false })]);
	});

	it("a failed result and a broken script are tool errors; a broken script says so", async () => {
		const t = toyProject({ build: [{ ok: false, summary: "NVFORTRAN-S-0155", signature: "S-0155" }, { mode: "exit", code: 3 }] });
		const { tool } = await session(t);
		expect(await tool("build", { variant: "gpu" })).toEqual({ isError: true, text: "NVFORTRAN-S-0155" });
		const broken = await tool("build", { variant: "gpu" });
		expect(broken.isError).toBe(true);
		expect(broken.text).toMatch(/script itself failed[\s\S]*not a failed result[\s\S]*report_blocked/);
		expect(scripts(t).map((e) => [e.outcome, e.ok, e.signature])).toEqual([
			["result", false, "S-0155"],
			["script_error", null, null],
		]);
	});

	describe("requires", () => {
		it("refuses run_sample before build, naming build, without running anything", async () => {
			const t = toyProject();
			const { tool } = await session(t);
			const r = await tool("run_sample");
			expect(r.isError).toBe(true);
			expect(r.text).toBe("run_sample was not run: it requires build to succeed first in this session, with no edit or write of a file since. Call build, then call run_sample again.");
			expect(t.scriptCalls()).toEqual([]);
			expect(scripts(t)).toEqual([]);
		});

		it("allows run_sample after build; an edit or write that ran, nested or not, makes it stale; a blocked one does not", async () => {
			const t = toyProject();
			const { tool, edited } = await session(t);
			const build = () => tool("build", { variant: "cpu" });
			const sample = async () => (await tool("run_sample")).isError;
			await build();
			expect(await sample()).toBe(false);
			await edited("edit"); // Blocked by the guard: it did not run.
			expect(await sample()).toBe(false);
			await edited("edit", 4);
			expect(await sample()).toBe(true);
			await build();
			await edited("write", 2, "parent-call"); // Made by another tool.
			expect(await sample()).toBe(true);
			await build();
			await edited("bash", 30);
			expect(await sample()).toBe(false);
		});

		it("a failed build after a successful one makes run_sample wait for the next success", async () => {
			const t = toyProject({ build: [{ ok: true, summary: "built" }, { ok: false, summary: "broke" }, { ok: true, summary: "built" }] });
			const { tool } = await session(t);
			await tool("build", { variant: "cpu" });
			await tool("build", { variant: "cpu" });
			expect((await tool("run_sample")).isError).toBe(true);
			await tool("build", { variant: "cpu" });
			expect((await tool("run_sample")).isError).toBe(false);
		});

		it("is per step attempt: a build before the step started does not count inside it", async () => {
			const t = toyProject();
			const { run, tool } = await session(t);
			await run("/plan-new e1 Goal");
			await tool("build", { variant: "cpu" });
			await run("/step offload R17 -- Port R17");
			const r = await tool("run_sample");
			expect(r.text).toMatch(/requires build to succeed first in step s1/);
		});

		it("is rebuilt from the event log after a restart", async () => {
			const t = toyProject();
			const first = await session(t);
			await first.run("/plan-new e1 Goal");
			await first.run("/step offload R17 -- Port R17");
			await first.tool("build", { variant: "cpu" });
			const second = await session(t);
			expect((await second.tool("run_sample")).isError).toBe(false);
			await second.edited("edit", 3); // Logged as a tool_call by the logging handler.
			const third = await session(t);
			expect((await third.tool("run_sample")).text).toMatch(/requires build/);
		});
	});

	it("a procedure whose name pi already uses (a built-in or another extension's tool) is not registered; the others are, and the person is told", async () => {
		const procs = defaultConfig().procedures as Record<string, unknown>[];
		const t = toyProject({}, { procedures: [...procs, { ...procs[0], name: "read" }, { ...procs[0], name: "gate" }] });
		const pi = new FakePi();
		pi.builtinTools.push("gate"); // Stands in for another extension's tool.
		await session(t, pi);
		expect(pi.tools.has("read")).toBe(false);
		expect(pi.tools.has("gate")).toBe(false);
		for (const name of PROCEDURES) expect(pi.tools.has(name)).toBe(true);
		expect(pi.notifications).toEqual([
			{
				type: "warning",
				message: expect.stringMatching(/procedures were not registered as tools, because pi already has tools with their names: "read" \(already a tool from builtin:read\), "gate" .*Rename them in harness.json/),
			},
		]);
	});

	it("a broken harness.json registers no procedure tools and is reported; the rest of the harness keeps working", async () => {
		const t = toyProject();
		writeFileSync(join(t.dir, "harness/harness.json"), "{ not json");
		const { pi, run } = await session(t);
		for (const name of PROCEDURES) expect(pi.tools.has(name)).toBe(false);
		expect(pi.notifications).toEqual([{ type: "error", message: expect.stringMatching(/^harness: no procedure tools were registered: .*not valid JSON/s) }]);
		expect(t.readEvents()).toEqual([expect.objectContaining({ type: "session_start" })]);
		await run("/plan-new e1 Goal");
		expect(t.readPlan("e1")).toMatchObject({ plan_id: "e1" });
	});

	it("a second session_start in another project deactivates the earlier procedures, which then refuse to run; one with no project deactivates all", async () => {
		const procs = defaultConfig().procedures as Record<string, unknown>[];
		const a = toyProject();
		const b = toyProject({ profile: [] }, { procedures: [{ ...procs[0], name: "profile", params: {} }, { ...procs[1], requires: [] }] });
		const pi = new FakePi();
		await session(a, pi);
		expect(pi.activeTools).toEqual(expect.arrayContaining(PROCEDURES));
		const inB = await session(b, pi);
		expect(pi.activeTools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "submit", "profile", "run_sample"]));
		expect(pi.activeTools).not.toContain("build");
		expect(pi.activeTools).not.toContain("wait_for_job");
		expect(await inB.tool("build", { variant: "cpu" })).toEqual({ isError: true, text: "build is not a procedure of the current project, so it was not run. Do not call it again." });
		expect((await inB.tool("run_sample")).isError).toBe(false); // B's run_sample has no requires.
		expect(b.scriptCalls().map((c) => c.name)).toEqual(["run_sample"]);
		expect(a.scriptCalls()).toEqual([]);

		const empty = mkdtempSync(join(tmpdir(), "harness-none-"));
		cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
		await pi.fire("session_start", { type: "session_start", reason: "new" }, { cwd: empty });
		for (const name of [...PROCEDURES, "profile"]) expect(pi.activeTools).not.toContain(name);
		expect(pi.activeTools).toContain("read");
		expect(pi.textOf(await pi.callTool("run_sample", {}, { cwd: empty }))).toMatch(/not a procedure of the current project/);
	});
});
