// Level 2: /run-plan in a real pi session with the scripted model. The next step starts from
// agent_settled with pi.sendUserMessage (docs/pi-facts.md, change 6). The first test is the drift
// test for that mechanism.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptEntry } from "../rig/script.ts";
import { runSdkSession, type SdkSession, type SdkSessionOptions } from "../rig/sdk-session.ts";
import { type Behavior, defaultConfig, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let s: SdkSession | undefined;
let toy: ToyProject | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
	toy?.cleanup();
	toy = undefined;
});

const submit: ScriptEntry = { tool: "submit" };

/**
 * A session with plan e1 and two pending measure steps, s1 "First" and s2 "Second". `config`
 * replaces top-level fields of harness.json.
 */
async function twoSteps(script: ScriptEntry[], config: Record<string, unknown>, extra: Partial<SdkSessionOptions> = {}, behavior: Behavior = {}): Promise<SdkSession> {
	toy = makeToyProject({ config, behavior });
	s = await runSdkSession({ project: toy, script, ...extra });
	await s.prompt("/plan-new e1 Goal");
	await s.prompt("/add-step measure -- First");
	await s.prompt("/add-step measure -- Second");
	return s;
}

const auto = { run_plan: { approve: "auto" } };
const ask = { run_plan: { approve: "ask" } };
const statuses = (t: SdkSession) => (t.project.readPlan("e1") as { steps: { status: string }[] }).steps.map((x) => x.status);
const ofType = (type: string) => toy!.readEvents().filter((e) => e.type === type);
/** The step prompts the model received, by step id, in order. */
const promptedSteps = (t: SdkSession) =>
	t.requests().flatMap((r) => {
		const last = r.messages.at(-1);
		const text = JSON.stringify(last?.content ?? "");
		const m = /\[harness step (s\d+)/.exec(text);
		return last?.role === "user" && m ? [m[1]] : [];
	});

describe("/run-plan in a real session", () => {
	it("[drift] agent_settled: two pending steps both pass, in order, with mode run_plan in the log; with auto each boundary is a notice", async () => {
		const t = await twoSteps([submit, submit, { text: "s3 seen" }], auto, { ui: { select: [] } });
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["passed", "passed"]);
		expect(promptedSteps(t)).toEqual(["s1", "s2"]);
		expect(ofType("step_start").map((e) => [e.step, e.mode])).toEqual([["s1", "run_plan"], ["s2", "run_plan"]]);
		expect(ofType("step_end").map((e) => [e.step, e.outcome, e.mode])).toEqual([["s1", "passed", "run_plan"], ["s2", "passed", "run_plan"]]);
		expect(t.project.readSteps().map((r) => [r.step, r.mode])).toEqual([["s1", "run_plan"], ["s2", "run_plan"]]);
		expect(t.dialogs).toEqual([]);
		expect(t.notices).toEqual(
			expect.arrayContaining([
				"Step s1 passed: First\nCheck: check ok\nUsed: 110 tokens, $0.0015\nNext: s2: Second",
				expect.stringMatching(/^Step s2 passed: Second\n[\s\S]*Next: none/),
				"run-plan ended: the plan has no pending step left. The session is supervised again.",
			]),
		);
		// The mode is off again: a later step starts supervised.
		await t.prompt("/step measure -- Third");
		expect(ofType("step_start").at(-1)).toMatchObject({ step: "s3", mode: "supervised" });
	});

	it("the first step ends blocked: the second stays pending and the mode ends", async () => {
		const t = await twoSteps([{ tool: "report_blocked", args: { reason: "no GPU node" } }], auto, { ui: { select: [] } });
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["blocked", "pending"]);
		expect(t.requests()).toHaveLength(1);
		expect(t.notices.at(-1)).toBe("harness: run-plan ended: step s1 ended blocked: no GPU node. The session is supervised again.");
		expect(ofType("step_start")).toHaveLength(1);
	});

	it("the agent stops without submit: no continuation happens (the endless-loop guard)", async () => {
		// One entry only: a further model request would exhaust the script and fail the test.
		const t = await twoSteps([{ text: "I think it is done." }], auto, { ui: { select: [] } });
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["active", "pending"]);
		expect(t.requests()).toHaveLength(1);
		expect(t.notices.at(-1)).toMatch(/^harness: run-plan ended: the agent stopped without calling submit or report_blocked; step s1 is still active/);
		// The step stays active under supervision; its later events carry mode supervised.
		await t.prompt("/abandon left for later");
		expect(ofType("step_end")).toEqual([expect.objectContaining({ step: "s1", outcome: "abandoned", mode: "supervised" })]);
		// The record keeps the mode the step started in.
		expect(t.project.readSteps()).toEqual([expect.objectContaining({ step: "s1", mode: "run_plan" })]);
	});

	it("/run-plan 1 with two pending steps runs one", async () => {
		const t = await twoSteps([submit], auto);
		await t.prompt("/run-plan 1");
		expect(statuses(t)).toEqual(["passed", "pending"]);
		expect(t.requests()).toHaveLength(1);
	});

	it("approve ask, answer stop: the second step stays pending; the dialog shows the boundary summary", async () => {
		const t = await twoSteps([submit], ask, { ui: { select: ["Stop"] } });
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["passed", "pending"]);
		expect(t.dialogs).toEqual([
			{ title: "Step s1 passed: First\nCheck: check ok\nUsed: 110 tokens, $0.0015\nNext: s2: Second\n\nStart s2?", options: ["Continue", "Stop", "Stop and edit the plan"] },
		]);
		expect(t.notices.at(-1)).toBe("run-plan ended: you chose stop. The session is supervised again.");
	});

	it("approve ask, answer continue: the second step starts and passes", async () => {
		const t = await twoSteps([submit, submit], ask, { ui: { select: ["Continue"] } });
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["passed", "passed"]);
		expect(t.dialogs).toHaveLength(1); // No dialog after the last step: nothing is left to start.
	});

	it("approve ask, stop and edit: the mode ends, and the person is shown the plan and where to edit it", async () => {
		const t = await twoSteps([submit], ask, { ui: { select: ["Stop and edit the plan"] } });
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["passed", "pending"]);
		expect(t.notices.at(-1)).toMatch(/^Plan e1: Goal[\s\S]*s2[\s\S]*Edit the pending steps in .*harness\/plans\/e1\.json or with \/add-step/);
	});

	it("approve ask with no user interface: ask cannot ask, so the mode stops instead of continuing", async () => {
		const t = await twoSteps([submit], ask);
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["passed", "pending"]);
		expect(t.requests()).toHaveLength(1);
	});

	it("a stop rule uses rules.run_plan: the step is stopped and the mode ends", async () => {
		const base = defaultConfig() as { kinds: Record<string, { budget: Record<string, number> }>; rules: Record<string, unknown> };
		base.kinds.measure!.budget = { ...base.kinds.measure!.budget, tokens: 150 };
		const ping: ScriptEntry = { tool: "harness_ping" };
		const t = await twoSteps([ping, ping, ping], { ...auto, kinds: base.kinds, rules: { ...base.rules, supervised: "warn", run_plan: "stop" } });
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["stopped", "pending"]);
		expect(t.requests()).toHaveLength(2);
		expect(ofType("rule_tripped")).toEqual([expect.objectContaining({ rule: "budget_tokens", action: "stop", mode: "run_plan" })]);
		expect(ofType("interruption")).toEqual([]);
	});

	it("the person aborts the run: no continuation, and the mode ends", async () => {
		const gate = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "gate",
				label: "Gate",
				description: "Test tool.",
				parameters: Type.Object({}),
				async execute(_id, _params, signal) {
					void s!.session.abort();
					await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
					return { content: [{ type: "text", text: "gate aborted" }], details: undefined };
				},
			});
		};
		const t = await twoSteps([{ tool: "gate" }], auto, { factories: [gate] });
		await t.prompt("/run-plan");
		expect(statuses(t)).toEqual(["active", "pending"]);
		expect(t.requests()).toHaveLength(1);
		expect(ofType("interruption")).toEqual([expect.objectContaining({ how: "abort", mode: "run_plan" })]);
	});
});
