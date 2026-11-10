// Level 1: the fake project script that stands in for check, build, and the other procedures.
// The fake is called through the wrapper scripts that makeToyProject writes into harness/scripts/.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

/** Run harness/scripts/<name> in the toy project, as the extension will. */
function call(t: ToyProject, name: string, args: string[] = [], stdin = "{}", timeoutMs = 5000) {
	const r = spawnSync(`harness/scripts/${name}`, args, {
		cwd: t.dir,
		input: stdin,
		encoding: "utf8",
		timeout: timeoutMs,
		env: { ...process.env, HARNESS_PLAN: "e1", HARNESS_STEP: "s1", HARNESS_ATTEMPT: "1", HARNESS_KIND: "measure" },
	});
	const lines = r.stdout.trimEnd().split("\n");
	return { status: r.status, signal: r.signal, stdout: r.stdout, lastLine: lines[lines.length - 1] ?? "" };
}

describe("fake-script", () => {
	it("returns its entries in order and then repeats the last one", () => {
		toy = makeToyProject({
			behavior: {
				check: [
					{ ok: false, summary: "2 tests failed", signature: "T1,T2" },
					{ ok: true, summary: "all tests pass" },
				],
			},
		});
		const results = [1, 2, 3].map(() => JSON.parse(call(toy!, "check", ["measure"]).lastLine));
		expect(results.map((r) => r.ok)).toEqual([false, true, true]);
		expect(results[0]).toMatchObject({ summary: "2 tests failed", signature: "T1,T2" });
		expect(results[2].summary).toBe("all tests pass");
	});

	it("keeps a separate position for each script name", () => {
		toy = makeToyProject({
			behavior: {
				build: [{ ok: false, summary: "NVFORTRAN-S-0155" }, { ok: true, summary: "built" }],
				run_sample: [{ ok: true, summary: "ran" }],
			},
		});
		expect(JSON.parse(call(toy, "build").lastLine).ok).toBe(false);
		expect(JSON.parse(call(toy, "run_sample").lastLine).summary).toBe("ran");
		expect(JSON.parse(call(toy, "build").lastLine).summary).toBe("built");
	});

	it("prints free-form lines before the JSON last line", () => {
		toy = makeToyProject({ behavior: { build: [{ ok: true, summary: "built" }] } });
		const r = call(toy, "build");
		expect(r.status).toBe(0);
		expect(r.stdout.trimEnd().split("\n").length).toBeGreaterThan(1);
	});

	it("answers ok for a script name that has no behavior entry", () => {
		toy = makeToyProject({ behavior: {} });
		expect(JSON.parse(call(toy, "build").lastLine)).toMatchObject({ ok: true });
	});

	it("hang: runs until killed", () => {
		toy = makeToyProject({ behavior: { run_sample: [{ mode: "hang" }] } });
		const r = call(toy, "run_sample", [], "{}", 300);
		expect(r.signal).toBe("SIGTERM");
	});

	it("garbage: prints a last line that is not JSON", () => {
		toy = makeToyProject({ behavior: { build: [{ mode: "garbage" }] } });
		const r = call(toy, "build");
		expect(r.status).toBe(0);
		expect(() => JSON.parse(r.lastLine)).toThrow();
	});

	it("exit: leaves with the given nonzero code", () => {
		toy = makeToyProject({ behavior: { build: [{ mode: "exit", code: 3 }] } });
		expect(call(toy, "build").status).toBe(3);
	});

	it("big: prints a valid result whose summary is very long", () => {
		toy = makeToyProject({ behavior: { build: [{ mode: "big", chars: 50_000 }] } });
		const result = JSON.parse(call(toy, "build").lastLine);
		expect(result.ok).toBe(true);
		expect(result.summary.length).toBe(50_000);
	});

	it("records each call's arguments, standard input, and HARNESS_ variables", () => {
		toy = makeToyProject({ behavior: {} });
		call(toy, "check", ["offload", "R17"], JSON.stringify({ params: {}, plan: "e1", step: "s1", attempt: 1, kind: "offload" }));
		const calls = toy.scriptCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			name: "check",
			args: ["offload", "R17"],
			stdin: { params: {}, plan: "e1", step: "s1", attempt: 1, kind: "offload" },
			env: { HARNESS_PLAN: "e1", HARNESS_STEP: "s1", HARNESS_ATTEMPT: "1", HARNESS_KIND: "measure" },
		});
	});

	it("can change behavior between calls", () => {
		toy = makeToyProject({ behavior: { build: [{ ok: false, summary: "first" }] } });
		expect(JSON.parse(call(toy, "build").lastLine).ok).toBe(false);
		toy.setBehavior({ build: [{ ok: true, summary: "second" }] });
		expect(JSON.parse(call(toy, "build").lastLine).summary).toBe("second");
	});
});
