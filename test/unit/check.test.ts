// Level 1: runCheck, the function behind submit (and later the headless runner).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CheckRequest, runCheck } from "../../src/core/check.ts";
import { loadConfig } from "../../src/core/config.ts";
import { EventLog } from "../../src/core/log.ts";
import { currentCommit } from "../../src/core/protect.ts";
import { FakeClock } from "../rig/clock.ts";
import { type Behavior, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

function setup(behavior: Behavior): { t: ToyProject; req: CheckRequest } {
	const t = makeToyProject({ behavior });
	toy = t;
	const step = { plan: "e1", step: "s2", attempt: 3 };
	const log = new EventLog({ path: join(t.dir, "harness/log/events.jsonl"), context: () => ({ session: "x", mode: "supervised", step }) });
	const req: CheckRequest = {
		root: t.dir,
		harnessDir: "harness",
		config: loadConfig(t.dir),
		plan: "e1",
		step: { id: "s2", kind: "offload", attempt: 3, check_args: ["R17", "R18"] },
		baseCommit: currentCommit(t.dir),
		by: "submit",
		log,
		clock: new FakeClock(),
	};
	return { t, req };
}

const checks = (t: ToyProject) => t.readEvents().filter((e) => e.type === "check");

describe("runCheck", () => {
	it("passes, and writes a check event", async () => {
		const { t, req } = setup({ check: [{ ok: true, summary: "all tests pass" }] });
		expect(await runCheck(req)).toEqual({ status: "passed", summary: "all tests pass", text: "The check passed: all tests pass" });
		expect(checks(t)).toEqual([
			expect.objectContaining({ step: "s2", attempt: 3, outcome: "result", ok: true, signature: null, summary: "all tests pass", by: "submit", duration_ms: 0 }),
		]);
	});

	it("runs the kind's check command with the step's check args and the script-contract input", async () => {
		const { t, req } = setup({});
		await runCheck(req);
		expect(t.scriptCalls()).toEqual([
			expect.objectContaining({
				name: "check",
				args: ["offload", "R17", "R18"],
				stdin: { params: {}, plan: "e1", step: "s2", attempt: 3, kind: "offload" },
				env: { HARNESS_PLAN: "e1", HARNESS_STEP: "s2", HARNESS_ATTEMPT: "3", HARNESS_KIND: "offload" },
			}),
		]);
	});

	it("fails with the check's summary and signature, and writes a check event", async () => {
		const { t, req } = setup({ check: [{ ok: false, summary: "2 tests failed", signature: "T1,T2" }] });
		const result = await runCheck({ ...req, by: "runner" });
		expect(result).toMatchObject({ status: "failed", signature: "T1,T2" });
		expect(result.text).toMatch(/^The check did not pass:\n2 tests failed\n/);
		expect(checks(t)).toEqual([expect.objectContaining({ outcome: "result", ok: false, signature: "T1,T2", summary: "2 tests failed", by: "runner" })]);
	});

	for (const [name, entry] of [
		["a nonzero exit", { mode: "exit", code: 3 }],
		["output that is not JSON", { mode: "garbage" }],
	] as const) {
		it(`reports a script error for ${name}, tells the agent to call report_blocked, and writes a check event`, async () => {
			const { t, req } = setup({ check: [entry] });
			const result = await runCheck(req);
			expect(result.status).toBe("error");
			expect(result.text).toMatch(/The check itself is broken, so this does not count as a failed attempt/);
			expect(result.text).toMatch(/Call report_blocked/);
			expect(checks(t)).toEqual([expect.objectContaining({ outcome: "script_error", ok: null, signature: null })]);
		});
	}

	it("fails with signature protected_changed before running the script, and lists the files", async () => {
		const { t, req } = setup({ check: [{ ok: true, summary: "all tests pass" }] });
		writeFileSync(join(t.dir, "tests/test_solver.txt"), "expect nothing\n");
		writeFileSync(join(t.dir, "tests/test_new.txt"), "new\n");
		const result = await runCheck(req);
		expect(result).toMatchObject({ status: "failed", signature: "protected_changed" });
		expect(result.text).toMatch(/protected files changed: tests\/test_new.txt, tests\/test_solver.txt/);
		expect(result.text).toMatch(/call submit again/);
		expect(t.scriptCalls()).toEqual([]);
		expect(t.readEvents().map((e) => e.type)).toEqual(["protected_changed", "check"]);
		expect(t.readEvents()[0]).toMatchObject({ paths: ["tests/test_new.txt", "tests/test_solver.txt"] });
		expect(checks(t)[0]).toMatchObject({ outcome: "result", ok: false, signature: "protected_changed" });
	});

	it("reports an error, not a failure, without a recorded commit, outside git, or for an unknown kind", async () => {
		const { t, req } = setup({});
		const results = [
			await runCheck({ ...req, baseCommit: null }),
			await runCheck({ ...req, baseCommit: "0123456789abcdef0123456789abcdef01234567" }),
			await runCheck({ ...req, step: { ...req.step, kind: "tune" } }),
		];
		expect(results.map((r) => r.status)).toEqual(["error", "error", "error"]);
		expect(results[0]!.text).toMatch(/no commit was recorded when step s2 started/);
		expect(results[1]!.text).toMatch(/the protected-file check could not run/);
		expect(results[2]!.text).toMatch(/harness.json defines no kind "tune"/);
		expect(t.scriptCalls()).toEqual([]);
		expect(checks(t).map((e) => e.outcome)).toEqual(["script_error", "script_error", "script_error"]);
	});

	it("reports an aborted check as aborted", async () => {
		const { t, req } = setup({ check: [{ mode: "hang" }] });
		const controller = new AbortController();
		const pending = runCheck({ ...req, signal: controller.signal });
		// Abort once the script has started.
		while (t.scriptCalls().length === 0) await new Promise((r) => setTimeout(r, 10));
		controller.abort();
		expect((await pending).status).toBe("aborted");
		expect(checks(t)).toEqual([expect.objectContaining({ outcome: "aborted", ok: null })]);
	});
});
