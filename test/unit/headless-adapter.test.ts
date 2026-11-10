// Level 1 (stub): the extension in headless mode, the handle the runner drives it through, and the
// runner's refusal of cache warming.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addStep } from "../../src/core/plan.ts";
import type { RunnerHandle } from "../../src/extension/headless.ts";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { noCacheWarming } from "../../src/runner/run.ts";
import { FakeClock } from "../rig/clock.ts";
import { type ContextOptions, FakePi } from "../rig/fake-pi.ts";
import { type Behavior, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

/** A headless instance with no UI, plan e1 with pending step s1, and the runner's handle. */
async function headless(behavior: Behavior = {}) {
	toy = makeToyProject({ behavior });
	let handle: RunnerHandle | undefined;
	const pi = new FakePi().load(createHarnessExtension({ clock: new FakeClock(), mode: "headless", connect: (h) => (handle = h) }));
	const opts: ContextOptions = { cwd: toy.dir, hasUI: false };
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, opts);
	await pi.runCommand("plan-new", "e1 Goal", opts);
	await pi.runCommand("add-step", "measure -- Profile it", opts);
	return { pi, opts, handle: handle! };
}

const ofType = (type: string) => toy!.readEvents().filter((e) => e.type === type);

describe("headless mode in the extension", () => {
	it("start() begins the step as /next-step does, with mode headless, and returns the prompt without sending it", async () => {
		const { pi, handle } = await headless();
		const plan = await handle.plan();
		const { ref, prompt } = handle.start(plan, plan.steps[0]!);
		expect(ref).toEqual({ plan: "e1", step: "s1", attempt: 1 });
		expect(prompt.split("\n")[0]).toBe("[harness step s1 | kind: measure | plan: e1]");
		expect(pi.sentUserMessages).toEqual([]);
		expect(ofType("step_start")).toEqual([expect.objectContaining({ step: "s1", mode: "headless", commit: expect.any(String) })]);
		expect(await handle.active(ref)).toBe(true);
	});

	it("a plan edited by someone else during submit stops the step with plan_changed_externally, marks it stopped in the edited file, and refuses further calls", async () => {
		const { pi, opts, handle } = await headless();
		const plan = await handle.plan();
		const { ref } = handle.start(plan, plan.steps[0]!);
		const path = join(toy!.dir, "harness/plans/e1.json");
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		const edited = addStep({ ...onDisk, goal: "Goal, edited" }, { kind: "measure", goal: "Added by hand" }).plan;
		writeFileSync(path, JSON.stringify(edited, null, 2));
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = await pi.callTool("submit", {}, { ...opts, idle: false });
		const told = stderr.mock.calls.map((c) => String(c[0])).join("");
		stderr.mockRestore();
		expect(result).toMatchObject({ isError: true });
		expect(pi.textOf(result)).toMatch(/plan e1 was changed outside the harness/);
		expect(toy!.readEvents().filter((e) => e.type === "rule_tripped" || e.type === "step_end").map((e) => e.type)).toEqual(["rule_tripped", "step_end"]);
		expect(ofType("rule_tripped").map((e) => [e.rule, e.action])).toEqual([["plan_changed_externally", "stop"]]);
		expect(toy!.readSteps().map((s) => [s.outcome, s.stop_rule, s.mode])).toEqual([["stopped", "plan_changed_externally", "headless"]]);
		// The person's edit is kept, and the file records the stop.
		const after = toy!.readPlan("e1") as { goal: string; steps: { id: string; status: string; goal: string; reason?: string }[] };
		expect(after.goal).toBe("Goal, edited");
		expect(after.steps.map((s) => [s.id, s.status, s.goal])).toEqual([["s1", "stopped", "Profile it"], ["s2", "pending", "Added by hand"]]);
		expect(after.steps[0]!.reason).toMatch(/^stop rule plan_changed_externally: plan e1 was changed outside the harness/);
		expect(told).toMatch(/step s1 stopped by stop rule plan_changed_externally.*It is marked stopped in .*e1\.json; the rest of the edit to that file was kept\./);
		expect(await handle.active(ref)).toBe(false);
		const blocked = (await pi.fire("tool_call", { type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "ls" } }, { ...opts, idle: false })).find(Boolean);
		expect(blocked).toMatchObject({ block: true, terminate: true, reason: expect.stringMatching(/stop rule plan_changed_externally/) });
		// The next read takes the file as it is: no second change, no second stop.
		expect((await handle.plan()).steps.map((s) => s.status)).toEqual(["stopped", "pending"]);
		expect(ofType("plan_changed_externally")).toHaveLength(1);
		expect(ofType("step_end")).toHaveLength(1);
	});

	it("a plan file made invalid during submit stops the step and leaves the file as it is", async () => {
		const { pi, opts, handle } = await headless();
		const plan = await handle.plan();
		const { ref } = handle.start(plan, plan.steps[0]!);
		const path = join(toy!.dir, "harness/plans/e1.json");
		writeFileSync(path, "{ not json");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = await pi.callTool("submit", {}, { ...opts, idle: false });
		const told = stderr.mock.calls.map((c) => String(c[0])).join("");
		stderr.mockRestore();
		expect(result).toMatchObject({ isError: true });
		expect(toy!.readSteps().map((s) => [s.outcome, s.stop_rule])).toEqual([["stopped", "plan_changed_externally"]]);
		expect(readFileSync(path, "utf8")).toBe("{ not json");
		expect(told).toMatch(/The plan file was not marked: .*e1\.json is not a valid plan, so the harness did not write it/);
		expect(await handle.active(ref)).toBe(false);
	});

	it("an edited plan without the active step stops the step, writes nothing, and says why", async () => {
		const { pi, opts, handle } = await headless();
		const plan = await handle.plan();
		handle.start(plan, plan.steps[0]!);
		const path = join(toy!.dir, "harness/plans/e1.json");
		const edited = JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), steps: [] }, null, 2);
		writeFileSync(path, edited);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await pi.callTool("submit", {}, { ...opts, idle: false });
		const told = stderr.mock.calls.map((c) => String(c[0])).join("");
		stderr.mockRestore();
		expect(toy!.readSteps().map((s) => s.outcome)).toEqual(["stopped"]);
		expect(readFileSync(path, "utf8")).toBe(edited);
		expect(told).toMatch(/The plan file was not marked: the edited .*e1\.json has no step s1, so the harness did not write it/);
	});

	it("a later /abandon of a leftover active step whose stop is already logged writes no second step_end or step record", async () => {
		const { pi, opts, handle } = await headless();
		const plan = await handle.plan();
		handle.start(plan, plan.steps[0]!);
		const path = join(toy!.dir, "harness/plans/e1.json");
		const original = readFileSync(path, "utf8");
		writeFileSync(path, "{ not json");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await pi.callTool("submit", {}, { ...opts, idle: false });
		stderr.mockRestore();
		writeFileSync(path, original); // The person fixes the file: s1 is still active there.
		const supervised = new FakePi().load(createHarnessExtension({ clock: new FakeClock() }));
		const later: ContextOptions = { cwd: toy!.dir, sessionId: "sess-2" };
		await supervised.fire("session_start", { type: "session_start", reason: "startup" }, later);
		await supervised.runCommand("abandon", "left over from the headless run", later);
		expect((toy!.readPlan("e1") as { steps: { status: string }[] }).steps.map((s) => s.status)).toEqual(["abandoned"]);
		expect(ofType("step_end").map((e) => e.outcome)).toEqual(["stopped"]);
		expect(toy!.readSteps().map((s) => [s.outcome, s.stop_rule])).toEqual([["stopped", "plan_changed_externally"]]);
		expect(supervised.notifications.filter((n) => n.type === "warning").map((n) => n.message)).toEqual([
			expect.stringMatching(/^harness: the ending of step s1 attempt 1 was already recorded as stopped \(stop rule plan_changed_externally: .*\); the plan file now shows it as abandoned, but the log and the step record keep the first ending\.$/),
		]);
	});

	it("a broken check in submit stops the step with check_error and ends the run, instead of asking for report_blocked", async () => {
		const { pi, opts, handle } = await headless({ check: [{ mode: "exit", code: 3 }] });
		const plan = await handle.plan();
		handle.start(plan, plan.steps[0]!);
		const result = await pi.callTool("submit", {}, { ...opts, idle: false });
		expect(result).toMatchObject({ isError: true, terminate: true });
		expect(pi.textOf(result)).toMatch(/^The harness stopped step s1 \(stop rule check_error: the check script is broken: The script itself failed/);
		expect(pi.textOf(result)).not.toMatch(/report_blocked/);
		expect(toy!.readSteps().map((s) => [s.outcome, s.stop_rule, s.check_attempts])).toEqual([["stopped", "check_error", 0]]);
	});

	it("handle.stop() while the agent is idle stops the step but leaves no refusal for the next run", async () => {
		const { pi, opts, handle } = await headless();
		const plan = await handle.plan();
		const { ref } = handle.start(plan, plan.steps[0]!);
		await handle.stop("max_iterations", "3 prompts without a pass", 3, 3);
		expect(handle.record(ref)).toMatchObject({ outcome: "stopped", stop_rule: "max_iterations", reason: "stop rule max_iterations: 3 prompts without a pass" });
		expect(ofType("rule_tripped")).toEqual([expect.objectContaining({ rule: "max_iterations", action: "stop", value: 3, limit: 3 })]);
		const call = await pi.fire("tool_call", { type: "tool_call", toolCallId: "c3", toolName: "bash", input: { command: "ls" } }, { ...opts, idle: false });
		expect(call.find(Boolean)).toBeUndefined();
	});
});

describe("noCacheWarming", () => {
	it("answers every cache-warming decision with stop", async () => {
		const pi = new FakePi().load(noCacheWarming);
		expect(await pi.fire("cache_warming_decision", { type: "cache_warming_decision", action: "warm", warmCost: 0.1, missCost: 1, continuationProbability: 0.9 })).toEqual([{ action: "stop" }]);
	});
});
