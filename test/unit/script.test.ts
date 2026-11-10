// Level 1: the script runner implements the script contract (plan Section 6).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunScriptOptions, runScript, type ScriptInput } from "../../src/core/script.ts";
import { isAlive, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

/** Poll until `predicate` is true; fail after `ms`. */
async function waitFor(predicate: () => boolean, ms = 3000, what = "condition"): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

const RUN_SCRIPT_PROCESS = new URL("../rig/run-script-process.ts", import.meta.url).pathname;

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

const input: ScriptInput = { params: { variant: "gpu" }, plan: "e1", step: "s2", attempt: 3, kind: "offload" };

function options(t: ToyProject, overrides: Partial<RunScriptOptions> = {}): RunScriptOptions {
	return {
		cwd: t.dir,
		name: "build",
		timeoutMs: 10_000,
		maxSummaryChars: 2000,
		outputDir: join(t.dir, "harness/log/outputs"),
		...overrides,
	};
}

describe("runScript", () => {
	it("parses the JSON last line after free-form lines", async () => {
		toy = makeToyProject({
			behavior: { build: [{ ok: false, summary: "NVFORTRAN-S-0155", signature: "S-0155", details_path: "build.log", data: { errors: 1 } }] },
		});
		const r = await runScript(["harness/scripts/build"], input, options(toy));
		expect(r).toMatchObject({
			kind: "result",
			ok: false,
			summary: "NVFORTRAN-S-0155",
			text: "NVFORTRAN-S-0155",
			signature: "S-0155",
			detailsPath: "build.log",
			data: { errors: 1 },
			timedOut: false,
		});
	});

	it("treats a null signature and a null details_path as absent", async () => {
		toy = makeToyProject({ behavior: { build: [{ ok: false, summary: "failed", signature: null, details_path: null }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy));
		expect(r).toMatchObject({ kind: "result", ok: false, signature: null, detailsPath: null });
	});

	it("gives signature null when the result has none", async () => {
		toy = makeToyProject({ behavior: { build: [{ ok: true, summary: "built" }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy));
		expect(r).toMatchObject({ kind: "result", ok: true, signature: null });
	});

	it("reports a nonzero exit code as a script error, not as ok: false", async () => {
		toy = makeToyProject({ behavior: { build: [{ mode: "exit", code: 3 }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy));
		expect(r.kind).toBe("script_error");
		if (r.kind !== "script_error") return;
		expect(r.exitCode).toBe(3);
		expect(r.error).toMatch(/exit code 3/);
		expect(r.text).toMatch(/script itself failed/);
	});

	it("reports death by a signal as a script error that names the signal", async () => {
		toy = makeToyProject({ behavior: { build: [{ mode: "signal", signal: "SIGKILL" }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy));
		expect(r.kind).toBe("script_error");
		if (r.kind === "script_error") {
			expect(r.error).toBe("killed by SIGKILL");
			expect(r.exitCode).toBeNull();
		}
	});

	it("reports a last line that is not JSON as a script error", async () => {
		toy = makeToyProject({ behavior: { build: [{ mode: "garbage" }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy));
		expect(r.kind).toBe("script_error");
		if (r.kind === "script_error") expect(r.error).toMatch(/last line .* not JSON/);
	});

	it("reports a JSON last line without a boolean ok as a script error", async () => {
		toy = makeToyProject({ behavior: { build: [{ summary: "no ok field" }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy));
		expect(r.kind).toBe("script_error");
		if (r.kind === "script_error") expect(r.error).toMatch(/"ok"/);
	});

	it("reports a missing executable as a script error that names the command", async () => {
		toy = makeToyProject();
		const r = await runScript(["harness/scripts/no_such_script"], input, options(toy));
		expect(r.kind).toBe("script_error");
		if (r.kind === "script_error") expect(r.error).toMatch(/harness\/scripts\/no_such_script/);
	});

	it("kills a script that passes its time limit and returns ok: false with signature timeout", async () => {
		toy = makeToyProject({ behavior: { run_sample: [{ mode: "hang" }] } });
		const started = Date.now();
		const r = await runScript(["harness/scripts/run_sample"], input, options(toy, { name: "run_sample", timeoutMs: 300 }));
		expect(Date.now() - started).toBeLessThan(5000);
		expect(r).toMatchObject({ kind: "result", ok: false, signature: "timeout", timedOut: true });
		if (r.kind === "result") expect(r.summary).toBe("timed out after 0.3 seconds");
	});

	it("kills a script that ignores the terminate signal after the grace period", async () => {
		toy = makeToyProject({ behavior: { run_sample: [{ mode: "hang", ignore_term: true }] } });
		const started = Date.now();
		const r = await runScript(
			["harness/scripts/run_sample"],
			input,
			options(toy, { name: "run_sample", timeoutMs: 200, killGraceMs: 300 }),
		);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(r).toMatchObject({ kind: "result", ok: false, signature: "timeout" });
	});

	it("kills a running script when the abort signal fires", async () => {
		toy = makeToyProject({ behavior: { run_sample: [{ mode: "hang" }] } });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const started = Date.now();
		const r = await runScript(["harness/scripts/run_sample"], input, options(toy, { name: "run_sample", signal: controller.signal }));
		expect(Date.now() - started).toBeLessThan(5000);
		expect(r).toMatchObject({ kind: "aborted" });
	});

	it("does not start a script when the signal is already aborted", async () => {
		toy = makeToyProject();
		const controller = new AbortController();
		controller.abort();
		const r = await runScript(["harness/scripts/build"], input, options(toy, { signal: controller.signal }));
		expect(r).toMatchObject({ kind: "aborted" });
		expect(toy.scriptCalls()).toHaveLength(0);
	});

	it("kills the whole process group at the time limit, including the script's children", async () => {
		toy = makeToyProject({ behavior: { run_sample: [{ mode: "hang", child: "group" }] } });
		const r = await runScript(["harness/scripts/run_sample"], input, options(toy, { name: "run_sample", timeoutMs: 300 }));
		expect(r).toMatchObject({ kind: "result", signature: "timeout" });
		const child = toy.childPid("run_sample")!;
		await waitFor(() => !isAlive(child), 3000, `child ${child} to die`);
	});

	it("returns the result of a script that exits while a background child still holds its output", async () => {
		toy = makeToyProject({ behavior: { build: [{ ok: true, summary: "built", child: "group" }] } });
		const started = Date.now();
		const r = await runScript(["harness/scripts/build"], input, options(toy, { timeoutMs: 5000, drainMs: 100 }));
		expect(Date.now() - started).toBeLessThan(2000);
		expect(r).toMatchObject({ kind: "result", ok: true, summary: "built", timedOut: false });
	});

	it("returns at the time limit even when a child escaped the group and holds the output open", async () => {
		toy = makeToyProject({ behavior: { run_sample: [{ mode: "hang", child: "escape" }] } });
		const started = Date.now();
		const r = await runScript(
			["harness/scripts/run_sample"],
			input,
			options(toy, { name: "run_sample", timeoutMs: 200, killGraceMs: 200, drainMs: 100 }),
		);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(r).toMatchObject({ kind: "result", signature: "timeout" });
	});

	it("writes output to the file while the script is still running", async () => {
		toy = makeToyProject({ behavior: { run_sample: [{ mode: "hang" }] } });
		const outputDir = join(toy.dir, "harness/log/outputs");
		const running = runScript(["harness/scripts/run_sample"], input, options(toy, { name: "run_sample", timeoutMs: 2000, outputDir }));
		const outputs = () => (existsSync(outputDir) ? readdirSync(outputDir) : []);
		await waitFor(() => outputs().some((f) => readFileSync(join(outputDir, f), "utf8").includes("fake run_sample")), 1500, "streamed output");
		await running;
	});

	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		it(`terminates running scripts when the harness process receives ${signal}`, async () => {
			toy = makeToyProject({ behavior: { wait_for_job: [{ mode: "hang" }] } });
			const runner = spawn(process.execPath, [RUN_SCRIPT_PROCESS, toy.dir, "wait_for_job"], { stdio: "ignore" });
			await waitFor(() => toy!.scriptCalls().length === 1, 5000, "the script to start");
			const scriptPid = toy.scriptCalls()[0]!.pid;
			runner.kill(signal);
			await waitFor(() => !isAlive(scriptPid), 3000, `script ${scriptPid} to die`);
			await waitFor(() => runner.exitCode !== null || runner.signalCode !== null, 3000, "the harness process to exit");
		});
	}

	it("cuts a long summary and says how much was removed and where the full output is", async () => {
		toy = makeToyProject({ behavior: { build: [{ mode: "big", chars: 5000 }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy, { maxSummaryChars: 100 }));
		expect(r.kind).toBe("result");
		if (r.kind !== "result") return;
		expect(r.summary.length).toBe(5000);
		const lines = r.text.split("\n");
		expect(lines[0]).toBe("x".repeat(100));
		expect(lines.at(-1)).toBe(`[4900 characters removed; full output: ${r.outputPath}]`);
	});

	it("returns the summary unchanged when it fits", async () => {
		toy = makeToyProject({ behavior: { build: [{ ok: true, summary: "x".repeat(100) }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy, { maxSummaryChars: 100 }));
		expect(r.text).toBe("x".repeat(100));
	});

	it("saves all standard output and standard error under the output directory", async () => {
		toy = makeToyProject({ behavior: { build: [{ mode: "exit", code: 2 }] } });
		const r = await runScript(["harness/scripts/build"], input, options(toy));
		expect(r.outputPath).toMatch(/^harness\/log\/outputs\/.*-build\.txt$/);
		const saved = readFileSync(join(toy.dir, r.outputPath), "utf8");
		expect(saved).toContain("fake build");
		expect(saved).toContain("exiting with 2");
	});

	it("gives each call its own output file", async () => {
		toy = makeToyProject();
		const a = await runScript(["harness/scripts/build"], input, options(toy));
		const b = await runScript(["harness/scripts/build"], input, options(toy));
		expect(a.outputPath).not.toBe(b.outputPath);
		expect(existsSync(join(toy.dir, a.outputPath))).toBe(true);
		expect(existsSync(join(toy.dir, b.outputPath))).toBe(true);
	});

	it("passes the input as JSON on standard input and as HARNESS_ variables, and appends arguments", async () => {
		toy = makeToyProject();
		await runScript(["harness/scripts/check", "offload", "R17"], input, options(toy, { name: "check" }));
		expect(toy.scriptCalls()[0]).toMatchObject({
			name: "check",
			args: ["offload", "R17"],
			stdin: input,
			env: { HARNESS_PLAN: "e1", HARNESS_STEP: "s2", HARNESS_ATTEMPT: "3", HARNESS_KIND: "offload" },
		});
	});

	it("sets HARNESS_ variables to empty strings when no step is active", async () => {
		toy = makeToyProject();
		await runScript(["harness/scripts/build"], { params: {}, plan: null, step: null, attempt: null, kind: null }, options(toy));
		expect(toy.scriptCalls()[0]!.env).toEqual({ HARNESS_PLAN: "", HARNESS_STEP: "", HARNESS_ATTEMPT: "", HARNESS_KIND: "" });
	});

	it("measures the duration with the clock it is given", async () => {
		toy = makeToyProject();
		let t = 1_000;
		const clock = { now: () => (t += 250) };
		const r = await runScript(["harness/scripts/build"], input, options(toy, { clock }));
		expect(r.durationMs).toBe(250);
	});
});
