// Level 2: procedure tools in a real pi session with the scripted model.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../rig/clock.ts";
import type { ScriptEntry } from "../rig/script.ts";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";
import { type Behavior, defaultConfig, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let s: SdkSession | undefined;
const toys: ToyProject[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await s?.dispose();
	s = undefined;
	for (const t of toys.splice(0)) t.cleanup();
});

function toyProject(options: Parameters<typeof makeToyProject>[0] = {}): ToyProject {
	const t = makeToyProject(options);
	toys.push(t);
	return t;
}

const scripts = (session: SdkSession) => session.project.readEvents().filter((e) => e.type === "script");
const shown = (session: SdkSession, i: number) => JSON.stringify(session.requests()[i]?.messages ?? []);

/** Resolves once the fake script `name` has been called, then runs `then`. Waits on a file, not on time. */
async function whenCalled(toy: ToyProject, name: string, then: () => unknown): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!toy.scriptCalls().some((c) => c.name === name)) {
		if (Date.now() > deadline) throw new Error(`the fake script ${name} was never called`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await then();
}

/** A test tool from another extension; it advances `clock` when given, to stand for the agent's time. */
const gate = (clock?: FakeClock) => (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "gate",
		label: "Gate",
		description: "Test tool.",
		parameters: Type.Object({}),
		async execute() {
			clock?.advanceMinutes(3);
			return { content: [{ type: "text", text: "gate done" }], details: undefined };
		},
	});
};

async function session(script: ScriptEntry[], behavior: Behavior = {}): Promise<SdkSession> {
	s = await runSdkSession({ project: toyProject({ behavior }), script });
	return s;
}

describe("procedure tools in a real session", () => {
	it("[build, run_sample, text]: two script events, and both summaries reach the model", async () => {
		const t = await session(
			[{ tool: "build", args: { variant: "gpu" } }, { tool: "run_sample", args: {} }, { text: "done" }],
			{ build: [{ ok: true, summary: "built for gpu" }], run_sample: [{ ok: true, summary: "sample ran in 4.2 s" }] },
		);
		await t.prompt("Build and run the sample.");
		expect(scripts(t)).toEqual([
			expect.objectContaining({ name: "build", outcome: "result", ok: true, is_wait: false, step: null }),
			expect.objectContaining({ name: "run_sample", outcome: "result", ok: true, is_wait: false, step: null }),
		]);
		expect(shown(t, 1)).toContain("built for gpu");
		expect(shown(t, 2)).toContain("sample ran in 4.2 s");
		expect(t.requests()[0]!.tools).toEqual(expect.arrayContaining(["build", "run_sample", "wait_for_job"]));
		expect(t.project.scriptCalls()[0]).toMatchObject({ name: "build", stdin: { params: { variant: "gpu" } } });
	});

	it("[run_sample, text] with no build: the refusal names build", async () => {
		const t = await session([{ tool: "run_sample", args: {} }, { text: "ok" }]);
		await t.prompt("Run the sample.");
		expect(t.toolResults()).toEqual([
			expect.objectContaining({ toolName: "run_sample", isError: true, text: expect.stringMatching(/requires build to succeed first.*Call build, then call run_sample again/) }),
		]);
		expect(t.project.scriptCalls()).toEqual([]);
	});

	it("a failing procedure is returned as a tool error", async () => {
		const t = await session([{ tool: "build", args: { variant: "gpu" } }, { text: "ok" }], { build: [{ ok: false, summary: "NVFORTRAN-S-0155: derived type not allowed" }] });
		await t.prompt("Build.");
		expect(t.toolResults()).toEqual([expect.objectContaining({ toolName: "build", isError: true, text: "NVFORTRAN-S-0155: derived type not allowed" })]);
		expect(scripts(t)).toEqual([expect.objectContaining({ name: "build", ok: false })]);
	});

	it("a procedure marked is_wait adds to wait_minutes and not to agent_minutes (fake clock)", async () => {
		const clock = new FakeClock();
		const toy = toyProject({ behavior: { check: [{ ok: true, summary: "profile recorded" }] } });
		const release = join(toy.workDir, "job-done");
		toy.setBehavior({ check: [{ ok: true, summary: "profile recorded" }], wait_for_job: [{ mode: "wait_for", file: release, ok: true, summary: "job 7 finished" }] });
		s = await runSdkSession({
			project: toy,
			harness: { clock },
			factories: [gate(clock)],
			script: [{ tool: "gate", args: {} }, { tool: "wait_for_job", args: { job_id: "7" } }, { tool: "submit", args: {} }, { text: "done" }],
		});
		await s.prompt("/plan-new e1 Goal");
		// While wait_for_job runs, 12 minutes pass; then the job is released.
		const waiting = whenCalled(toy, "wait_for_job", () => {
			clock.advanceMinutes(12);
			writeFileSync(release, "");
		});
		await s.prompt("/step measure -- Profile it");
		await waiting;
		expect(scripts(s)).toEqual([expect.objectContaining({ name: "wait_for_job", is_wait: true, ok: true, duration_ms: 12 * 60_000, step: "s1" })]);
		expect(toy.readSteps()).toEqual([expect.objectContaining({ step: "s1", outcome: "passed", wait_minutes: 12, agent_minutes: 3 })]);
	});

	it("a procedure aborted mid-script still writes its script event", async () => {
		const toy = toyProject({ behavior: { wait_for_job: [{ mode: "hang" }] } });
		s = await runSdkSession({ project: toy, script: [{ tool: "wait_for_job", args: { job_id: "7" } }, { text: "never requested" }] });
		const aborting = whenCalled(toy, "wait_for_job", () => s!.session.abort());
		await s.prompt("Wait for job 7.");
		await aborting;
		expect(scripts(s)).toEqual([expect.objectContaining({ name: "wait_for_job", is_wait: true, outcome: "aborted", ok: null, timed_out: false })]);
		expect(s.requests()).toHaveLength(1);
	});

	it("a built-in edit that ran makes run_sample stale, even one that failed; an edit the guard blocked does not", async () => {
		const t = await session([
			{ tool: "build", args: { variant: "cpu" } },
			{ tool: "edit", args: { path: "src/solver.txt", edits: [{ oldText: "solve", newText: "Solve" }] } },
			{ tool: "run_sample", args: {} },
			{ tool: "build", args: { variant: "cpu" } },
			{ tool: "edit", args: { path: "tests/test_solver.txt", edits: [{ oldText: "expect", newText: "hope" }] } },
			{ tool: "run_sample", args: {} },
			{ tool: "edit", args: { path: "src/solver.txt", edits: [{ oldText: "no such text", newText: "x" }] } },
			{ tool: "run_sample", args: {} },
			{ text: "done" },
		]);
		await t.prompt("Work.");
		const results = t.toolResults();
		expect(results.map((r) => [r.toolName, r.isError])).toEqual([
			["build", false],
			["edit", false],
			["run_sample", true],
			["build", false],
			["edit", true], // Blocked by the guard: protected file.
			["run_sample", false],
			["edit", true], // Ran and failed.
			["run_sample", true],
		]);
		expect(results[4]!.text).toMatch(/must not be changed/);
		expect(readFileSync(join(t.project.dir, "src/solver.txt"), "utf8")).toBe("Solve the tridiagonal system\n");
	});

	it("[drift] getAllTools: procedures named like a built-in or another extension's tool are not registered and the person is told; the others are", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const procs = defaultConfig().procedures as Record<string, unknown>[];
		const toy = toyProject({ config: { procedures: [...procs, { ...procs[0], name: "read" }, { ...procs[0], name: "gate" }] } });
		s = await runSdkSession({ project: toy, factories: [gate()], script: [{ tool: "read", args: { path: "src/solver.txt" } }, { tool: "gate", args: {} }, { text: "done" }] });
		await s.prompt("Read and gate.");
		expect(s.toolResults()).toEqual([
			expect.objectContaining({ toolName: "read", isError: false, text: expect.stringContaining("solve the tridiagonal system") }),
			expect.objectContaining({ toolName: "gate", isError: false, text: "gate done" }),
		]);
		expect(toy.scriptCalls()).toEqual([]);
		expect(s.requests()[0]!.tools).toEqual(expect.arrayContaining(["read", "gate", "build", "run_sample", "wait_for_job"]));
		const told = stderr.mock.calls.map((c) => String(c[0])).join("");
		expect(told).toMatch(/not registered as tools, because pi already has tools with their names: "read" \(already a tool from builtin:read\), "gate" \(already a tool from /);
	});
});
