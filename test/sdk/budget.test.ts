// Level 2: budgets and stop rules in a real pi session with the scripted model (110 tokens per call).
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptEntry } from "../rig/script.ts";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";
import { type Behavior, defaultConfig, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let s: SdkSession | undefined;
let toy: ToyProject | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
	toy?.cleanup();
	toy = undefined;
});

/** A toy project whose measure kind has `budget` and whose supervised action is `action`. */
function project(action: "warn" | "stop", budget: Record<string, number>, behavior: Behavior = {}): ToyProject {
	const base = defaultConfig() as { kinds: Record<string, { budget: Record<string, number> }>; rules: Record<string, unknown> };
	base.kinds.measure!.budget = { ...base.kinds.measure!.budget, ...budget };
	toy = makeToyProject({ behavior, config: { kinds: base.kinds, rules: { ...base.rules, supervised: action } } });
	return toy;
}

/** A session in `t` with plan e1, in which `/step measure -- Profile it` runs `script`. */
async function stepWith(t: ToyProject, script: ScriptEntry[], settings?: Record<string, unknown>): Promise<SdkSession> {
	s = await runSdkSession({ project: t, script, settings });
	await s.prompt("/plan-new e1 Goal");
	await s.prompt("/step measure -- Profile it");
	return s;
}

const ofType = (type: string) => toy!.readEvents().filter((e) => e.type === type);
const ping: ScriptEntry = { tool: "harness_ping" };

describe("budgets in a real session", () => {
	it("action warn: a run over a small token budget continues, with one rule_tripped warn", async () => {
		const t = await stepWith(project("warn", { tokens: 150 }), [ping, ping, ping, { text: "done" }]);
		expect(t.requests()).toHaveLength(4);
		expect(ofType("rule_tripped")).toEqual([expect.objectContaining({ step: "s1", rule: "budget_tokens", action: "warn", value: 220, limit: 150 })]);
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
	});

	it("action stop: the same run ends early, the step is stopped with rule budget_tokens, and the rest of the script is unused", async () => {
		const t = await stepWith(project("stop", { tokens: 150 }), [ping, ping, ping, { text: "done" }]);
		expect(t.requests()).toHaveLength(2);
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "stopped" }] });
		expect(t.project.readSteps()).toEqual([expect.objectContaining({ outcome: "stopped", stop_rule: "budget_tokens", tokens: 220 })]);
		// The second call's tool call was refused with a reason the agent can read.
		expect(t.toolResults()).toEqual([
			expect.objectContaining({ toolName: "harness_ping", isError: false }),
			expect.objectContaining({ toolName: "harness_ping", isError: true, text: expect.stringMatching(/The harness stopped step s1 \(stop rule budget_tokens/) }),
		]);
		// The harness's own abort is not an interruption by the person.
		expect(ofType("interruption")).toEqual([]);
	});

	it("[drift] turn_end: after a stop, the run is aborted even when a refused call does not end the batch (an unknown tool)", async () => {
		const t = await stepWith(project("stop", { tokens: 150 }), [ping, { tools: [ping, { tool: "no_such_tool" }] }, ping, { text: "done" }]);
		expect(t.requests()).toHaveLength(2);
		expect(t.project.readSteps()).toEqual([expect.objectContaining({ stop_rule: "budget_tokens" })]);
		expect(ofType("interruption")).toEqual([]);
	});

	it("action stop: checks that fail twice with the same signature stop the step with rule stall", async () => {
		const failing = { check: [{ ok: false, summary: "2 tests failed", signature: "T1,T2" }] };
		const t = await stepWith(project("stop", {}, failing), [{ tool: "submit" }, { tool: "submit" }, { tool: "submit" }, { text: "done" }]);
		expect(t.requests()).toHaveLength(2);
		expect(t.project.readSteps()).toEqual([expect.objectContaining({ outcome: "stopped", stop_rule: "stall", check_attempts: 2 })]);
		expect(t.toolResults().at(-1)).toMatchObject({ toolName: "submit", isError: true, text: expect.stringMatching(/2 tests failed[\s\S]*The harness stopped step s1 \(stop rule stall: the last two checks failed with the same signature T1,T2\)/) });
	});

	it("action stop: two failed checks with no signature and no change to the working tree stop the step with rule stall", async () => {
		const failing = { check: [{ ok: false, summary: "still wrong" }] };
		const t = await stepWith(project("stop", {}, failing), [{ tool: "submit" }, { tool: "submit" }, { tool: "submit" }, { text: "done" }]);
		expect(t.requests()).toHaveLength(2);
		expect(t.project.readSteps()).toEqual([expect.objectContaining({ stop_rule: "stall", reason: "stop rule stall: the working tree did not change between the last two failed checks" })]);
	});

	it("action stop: a change to the working tree between two failed checks is not a stall", async () => {
		const failing = { check: [{ ok: false, summary: "still wrong" }] };
		const script: ScriptEntry[] = [{ tool: "submit" }, { tool: "bash", args: { command: "echo more >> src/solver.txt" } }, { tool: "submit" }, { text: "done" }];
		const t = await stepWith(project("stop", {}, failing), script);
		expect(t.requests()).toHaveLength(4);
		expect(ofType("rule_tripped")).toEqual([]);
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
	});

	it("/retry-step of a stopped step starts a new attempt with a fresh tracker", async () => {
		const t = await stepWith(project("stop", { tokens: 150 }, { check: [{ ok: true, summary: "ok" }] }), [ping, ping, { tool: "submit" }, { text: "done" }]);
		await t.prompt("/retry-step s1");
		expect(t.project.readSteps()).toEqual([
			expect.objectContaining({ attempt: 1, outcome: "stopped", stop_rule: "budget_tokens", tokens: 220 }),
			expect.objectContaining({ attempt: 2, outcome: "passed", stop_rule: null, tokens: 110 }),
		]);
		expect(ofType("rule_tripped").map((e) => e.attempt)).toEqual([1]);
	});

	it("action warn: the warning is not repeated after a session restart", async () => {
		const t = project("warn", { tokens: 150 });
		await stepWith(t, [ping, ping, { text: "pausing" }]);
		await s!.dispose();
		s = await runSdkSession({ project: t, script: [ping, { text: "done" }] });
		await s.prompt("Continue the step.");
		expect(ofType("model_call").filter((e) => e.step === "s1")).toHaveLength(5);
		expect(ofType("rule_tripped")).toHaveLength(1);
	});

	it("[drift] session_compact: compaction calls the model with no assistant message_end; its usage is logged and counted", async () => {
		const t = await stepWith(project("warn", {}), [ping, { text: "working" }, { text: "## Goal\nsummary" }], {
			compaction: { enabled: false, keepRecentTokens: 1 },
		});
		const ends = () => t.events.filter((e) => e.type === "message_end" && e.message.role === "assistant").length;
		const before = ends();
		await t.session.compact();
		expect(t.requests()).toHaveLength(3);
		expect(ends()).toBe(before);
		expect(ofType("model_call").at(-1)).toMatchObject({ step: "s1", model: "scripted/scripted-1", total_tokens: 110, stop_reason: "compaction" });
	});

	it("[drift] session_tree: a branch summary calls the model with no assistant message_end; its usage is logged and counted", async () => {
		const t = await stepWith(project("warn", {}), [ping, { text: "working" }, { text: "## Goal\nbranch summary" }]);
		const ends = () => t.events.filter((e) => e.type === "message_end" && e.message.role === "assistant").length;
		const before = ends();
		// Go back to the step prompt and summarize the branch left behind.
		const first = t.session.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
		await t.session.navigateTree(first!.id, { summarize: true });
		expect(t.requests()).toHaveLength(3);
		expect(ends()).toBe(before);
		expect(ofType("model_call").at(-1)).toMatchObject({ step: "s1", total_tokens: 110, stop_reason: "branch_summary" });
	});
});
