// Level 1 (stub): the budget adapter. Rules after model calls and failed checks, warn once per rule
// per attempt (also after a restart), stop through finish(), blocked calls, and the abort.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { FakeClock } from "../rig/clock.ts";
import { type ContextOptions, FakePi } from "../rig/fake-pi.ts";
import { type Behavior, defaultConfig, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

/** harness.json with the measure kind's budget changed and the supervised action set. */
function config(action: "warn" | "stop", budget: Record<string, number>) {
	const base = defaultConfig() as { kinds: Record<string, { budget: Record<string, number> }>; rules: Record<string, unknown> };
	base.kinds.measure!.budget = { ...base.kinds.measure!.budget, ...budget };
	return { kinds: base.kinds, rules: { ...base.rules, supervised: action } };
}

async function session(t: ToyProject, clock: FakeClock, sessionId = "sess-1") {
	const pi = new FakePi().load(createHarnessExtension({ clock }));
	const opts: ContextOptions = { cwd: t.dir, sessionId };
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, opts);
	const run = async (line: string, extra: ContextOptions = {}) => {
		const [name, ...rest] = line.replace(/^\//, "").split(" ");
		await pi.runCommand(name!, rest.join(" "), { ...opts, ...extra });
	};
	const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0015 } };
	/** One assistant message of 110 tokens, as pi reports it. */
	const modelCall = () =>
		pi.fire("message_end", { type: "message_end", message: { role: "assistant", provider: "p", model: "m", usage, stopReason: "toolUse", content: [] } }, { ...opts, idle: false });
	const toolCall = async () =>
		(await pi.fire("tool_call", { type: "tool_call", toolCallId: "c9", toolName: "bash", input: { command: "ls" } }, { ...opts, idle: false })).find((r) => r !== undefined) as
			| { block: boolean; reason: string; terminate?: boolean }
			| undefined;
	const tool = (name: string, params: unknown) => pi.callTool(name, params, { ...opts, idle: false });
	return { pi, opts, run, modelCall, toolCall, tool };
}

async function withStep(action: "warn" | "stop", budget: Record<string, number>, behavior: Behavior = {}) {
	toy = makeToyProject({ config: config(action, budget), behavior });
	const clock = new FakeClock();
	const s = await session(toy, clock);
	await s.run("/plan-new e1 Goal");
	await s.run("/step measure -- Profile it");
	return { ...s, clock };
}

const ofType = (type: string) => toy!.readEvents().filter((e) => e.type === type);
const warnings = (pi: FakePi) => pi.notifications.filter((n) => n.type === "warning").map((n) => n.message);

describe("action warn", () => {
	it("over the token budget: one notice and one rule_tripped per rule per attempt, not one per model call", async () => {
		const { pi, modelCall } = await withStep("warn", { tokens: 150 });
		await modelCall();
		expect(ofType("rule_tripped")).toEqual([]);
		await modelCall();
		await modelCall();
		expect(ofType("rule_tripped")).toEqual([expect.objectContaining({ step: "s1", attempt: 1, rule: "budget_tokens", action: "warn", value: 220, limit: 150 })]);
		expect(warnings(pi)).toEqual([expect.stringMatching(/step s1 tripped the stop rule budget_tokens: 220 tokens used, budget 150\. Work continues/)]);
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
	});

	it("the once holds after a restart, because the tracker is rebuilt from the log", async () => {
		const { modelCall, clock } = await withStep("warn", { tokens: 150 });
		await modelCall();
		await modelCall();
		const second = await session(toy!, clock, "sess-2");
		await second.modelCall();
		expect(ofType("rule_tripped")).toHaveLength(1);
		expect(ofType("model_call")).toHaveLength(3);
	});

	it("a different rule tripping later gets its own notice", async () => {
		const { pi, modelCall, clock } = await withStep("warn", { tokens: 150, agent_minutes: 1 });
		await modelCall();
		await modelCall();
		clock.advanceMinutes(2);
		await modelCall();
		expect(ofType("rule_tripped").map((e) => e.rule)).toEqual(["budget_tokens", "budget_minutes"]);
		expect(warnings(pi)).toHaveLength(2);
	});

	it("a failed submit that stalls warns and returns only the check's failure to the agent", async () => {
		const { pi, tool } = await withStep("warn", {}, { check: [{ ok: false, summary: "2 failed", signature: "T1" }] });
		await tool("submit", {});
		const result = await tool("submit", {});
		expect(result.isError).toBe(true);
		expect(result.terminate).toBeUndefined();
		expect(pi.textOf(result)).not.toMatch(/stopped/);
		expect(ofType("rule_tripped")).toEqual([expect.objectContaining({ rule: "stall", action: "warn", value: null, limit: null })]);
	});
});

describe("action stop", () => {
	it("over the token budget: the step is stopped through finish, with the rule in the events and the step record", async () => {
		const { pi, modelCall } = await withStep("stop", { tokens: 150 });
		await modelCall();
		await modelCall();
		expect(ofType("rule_tripped")).toEqual([expect.objectContaining({ rule: "budget_tokens", action: "stop" })]);
		expect(ofType("step_end")).toEqual([expect.objectContaining({ outcome: "stopped", detail: "stop rule budget_tokens: 220 tokens used, budget 150" })]);
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ status: "stopped", reason: "stop rule budget_tokens: 220 tokens used, budget 150" }] });
		expect(toy!.readSteps()).toEqual([expect.objectContaining({ outcome: "stopped", stop_rule: "budget_tokens", tokens: 220, model_calls: 2 })]);
		expect(warnings(pi)).toEqual([expect.stringMatching(/step s1 stopped by stop rule budget_tokens.*\/retry-step s1/)]);
	});

	it("blocks further tool calls with a reason that ends the batch, aborts at the end of the turn, and logs no interruption", async () => {
		const { pi, opts, modelCall, toolCall } = await withStep("stop", { tokens: 150 });
		await modelCall();
		expect(await toolCall()).toBeUndefined();
		await modelCall();
		expect(await toolCall()).toEqual({ block: true, terminate: true, reason: expect.stringMatching(/^The harness stopped step s1 \(stop rule budget_tokens.*do not call more tools/) });
		await pi.fire("turn_end", { type: "turn_end" }, { ...opts, idle: false });
		expect(pi.agentCalls).toEqual(["abort"]);
		await pi.fire("agent_settled", { type: "agent_settled", aborted: true }, opts);
		expect(ofType("interruption")).toEqual([]);
		// The next run is not blocked.
		expect(await toolCall()).toBeUndefined();
	});

	it("does not abort at the end of a turn when no rule stopped the step", async () => {
		const { pi, opts, modelCall } = await withStep("stop", { tokens: 1000 });
		await modelCall();
		await pi.fire("turn_end", { type: "turn_end" }, { ...opts, idle: false });
		expect(pi.agentCalls).toEqual([]);
	});

	it("a failed submit with the same signature twice stops the step as stall, and submit says so and ends the run", async () => {
		const { pi, tool } = await withStep("stop", {}, { check: [{ ok: false, summary: "2 failed", signature: "T1" }] });
		const first = await tool("submit", {});
		expect(first.terminate).toBeUndefined();
		const second = await tool("submit", {});
		expect(second).toMatchObject({ isError: true, terminate: true });
		expect(pi.textOf(second)).toMatch(/^The check did not pass:\n2 failed[\s\S]*The harness stopped step s1 \(stop rule stall: the last two checks failed with the same signature T1\)/);
		expect(toy!.readSteps()).toEqual([expect.objectContaining({ outcome: "stopped", stop_rule: "stall", check_attempts: 2 })]);
	});

	it("max_check_attempts stops the step at the budget's number of failed checks", async () => {
		const { tool } = await withStep("stop", { check_attempts: 2 }, { check: [{ ok: false, summary: "a", signature: "A" }, { ok: false, summary: "b", signature: "B" }] });
		await tool("submit", {});
		// Make the tree differ so only max_check_attempts holds.
		writeFileSync(join(toy!.dir, "src/solver.txt"), "changed\n");
		await tool("submit", {});
		expect(ofType("rule_tripped").map((e) => [e.rule, e.action])).toEqual([["max_check_attempts", "stop"]]);
		expect(toy!.readSteps()).toEqual([expect.objectContaining({ stop_rule: "max_check_attempts" })]);
	});

	it("a broken check is not an attempt and trips nothing", async () => {
		const { tool } = await withStep("stop", { check_attempts: 1 }, { check: [{ mode: "exit", code: 3 }] });
		await tool("submit", {});
		await tool("submit", {});
		expect(ofType("rule_tripped")).toEqual([]);
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
	});

	it("/retry-step of a stopped step starts a new attempt with a fresh tracker", async () => {
		const { pi, opts, run, modelCall } = await withStep("stop", { tokens: 150 });
		await modelCall();
		await modelCall();
		await pi.fire("agent_settled", { type: "agent_settled", aborted: true }, opts);
		await run("/retry-step s1");
		expect(toy!.readPlan("e1")).toMatchObject({ steps: [{ status: "active", attempt: 2 }] });
		await modelCall();
		expect(ofType("rule_tripped")).toHaveLength(1);
		await modelCall();
		expect(ofType("rule_tripped").map((e) => e.attempt)).toEqual([1, 2]);
	});
});

describe("/plan-status and hidden model calls", () => {
	it("/plan-status shows the active step's usage against its budget", async () => {
		const { pi, run, modelCall, clock } = await withStep("warn", { tokens: 1000 });
		await modelCall();
		await modelCall();
		clock.advanceMinutes(3);
		pi.notifications.length = 0;
		await run("/plan-status");
		expect(pi.notifications.at(-1)?.message).toMatch(/\nUsage of s1: 220 of 1000 tokens, \$0\.003 of \$10, 3 of 60 agent minutes, 0 of 5 check attempts$/);
	});

	it("compaction and branch-summary usage is logged as model calls of the step and counts toward its budget", async () => {
		const { pi, opts, modelCall } = await withStep("warn", { tokens: 150 });
		const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
		await pi.fire("session_compact", { type: "session_compact", compactionEntry: { usage }, fromExtension: false, reason: "manual", willRetry: false }, opts);
		await pi.fire("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null, summaryEntry: { usage } }, opts);
		await pi.fire("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null }, opts);
		expect(ofType("model_call")).toEqual([
			expect.objectContaining({ step: "s1", model: "unknown", total_tokens: 50, stop_reason: "compaction" }),
			expect.objectContaining({ step: "s1", total_tokens: 50, stop_reason: "branch_summary" }),
		]);
		await modelCall();
		expect(ofType("rule_tripped")).toEqual([expect.objectContaining({ rule: "budget_tokens", value: 210 })]);
	});
});
