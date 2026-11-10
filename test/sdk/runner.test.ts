// Level 2: the headless runner in-process (runHeadless), with real pi sessions saved to files and
// the scripted model loaded through the runner's `extensions` option. In fresh_per_step mode every
// session loads the scripted model again, so each session's script starts at its first entry.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { appendControl, controlPath } from "../../src/core/control.ts";
import { addStep, newPlan, PlanStore, startStep } from "../../src/core/plan.ts";
import { feedbackPrompt } from "../../src/core/prompt.ts";
import { type RunOptions, runHeadless } from "../../src/runner/run.ts";
import { type ModelRequest, readRequests, SCRIPTED_MODEL_PATH, type ScriptEntry, writeScript } from "../rig/script.ts";
import { scrubProcessEnv } from "../rig/sdk-session.ts";
import { type Behavior, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

interface Setup {
	behavior?: Behavior;
	config?: Record<string, unknown>;
	/** Goals of the plan's pending steps, all of kind measure. Default one step, "First". */
	goals?: string[];
	options?: Partial<RunOptions>;
}

/** A toy project with plan e1 and pending steps, run with the scripted model. */
async function run(script: ScriptEntry[], setup: Setup = {}) {
	toy = makeToyProject({ behavior: setup.behavior, config: setup.config });
	makePlan(toy, setup.goals ?? ["First"]);
	return runOn(toy, script, setup.options);
}

function makePlan(t: ToyProject, goals: string[]): void {
	let plan = newPlan("e1", "Goal", new Date());
	for (const goal of goals) plan = addStep(plan, { kind: "measure", goal }).plan;
	const store = new PlanStore(t.dir);
	store.create(plan);
	store.setActive("e1");
}

async function runOn(t: ToyProject, script: ScriptEntry[], options: Partial<RunOptions> = {}) {
	const work = join(t.workDir, `runner-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(work, { recursive: true });
	const { scriptPath, requestsPath } = writeScript(work, script);
	scrubProcessEnv();
	process.env.HARNESS_TEST_SCRIPT = scriptPath;
	process.env.HARNESS_TEST_REQUESTS = requestsPath;
	const sessionDir = join(work, "sessions");
	const out: string[] = [];
	const err: string[] = [];
	const code = await runHeadless({
		project: t.dir,
		plan: "e1",
		model: "scripted/scripted-1",
		extensions: [SCRIPTED_MODEL_PATH],
		agentDir: join(work, "agent"),
		sessionDir,
		pollMs: 20,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
		...options,
	});
	const requests = readRequests(requestsPath);
	// The scripted model's answer after its script ran out would show here as an extra request.
	return { code, out, err, requests, sessionFiles: () => readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")) };
}

const ofType = (type: string) => toy!.readEvents().filter((e) => e.type === type);
const statuses = () => (toy!.readPlan("e1") as { steps: { status: string }[] }).steps.map((s) => s.status);
const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("") : "";
const lastUserText = (r: ModelRequest) => textOf(r.messages.findLast((m) => m.role === "user")?.content);

/** A test tool that runs `body` with the call's abort signal. */
const tool = (name: string, body: (signal: AbortSignal | undefined) => Promise<string> | string) => (pi: ExtensionAPI) => {
	pi.registerTool({
		name,
		label: name,
		description: "Test tool.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			return { content: [{ type: "text", text: await body(signal) }], details: undefined };
		},
	});
};

/** Wait until `condition` holds, checking every 10 ms; fail after `ms`. */
async function until(condition: () => boolean, what: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("harness-run in-process", () => {
	it("two steps that both pass: exit 0, both step records have mode headless, each session logs session_end", async () => {
		const r = await run([{ tool: "submit" }], { goals: ["First", "Second"] });
		expect(r.err).toEqual([]);
		expect(r.code).toBe(0);
		expect(statuses()).toEqual(["passed", "passed"]);
		expect(toy!.readSteps().map((s) => [s.step, s.outcome, s.mode])).toEqual([["s1", "passed", "headless"], ["s2", "passed", "headless"]]);
		expect(r.requests.map(lastUserText).map((t) => t.split("\n")[0])).toEqual(["[harness step s1 | kind: measure | plan: e1]", "[harness step s2 | kind: measure | plan: e1]"]);
		expect(ofType("session_end")).toHaveLength(2);
		// The step prompt is the harness's own message, not an interruption.
		expect(ofType("interruption")).toEqual([]);
		// The live feed: one line per event, with the running total.
		expect(r.out).toContainEqual(expect.stringMatching(/^\d\d:\d\d:\d\d s2 step_end passed \| 220 tokens \$0\.003$/));
	});

	it("the agent stops without submit and the runner's check passes: the step passes, by runner", async () => {
		const r = await run([{ text: "I think it is done." }]);
		expect(r.code).toBe(0);
		expect(statuses()).toEqual(["passed"]);
		expect(ofType("check").map((e) => [e.by, e.ok])).toEqual([["runner", true]]);
		expect(r.requests).toHaveLength(1);
		expect(r.out).toContainEqual(expect.stringMatching(/ s1 check by runner: passed - check ok \| 110 tokens/));
	});

	it("the agent stops without submit and the check fails: the next request carries the exact feedback prompt", async () => {
		const behavior = { check: [{ ok: false, summary: "2 tests failed", signature: "T1,T2" }, { ok: true, summary: "all pass" }] };
		const r = await run([{ text: "Done." }, { text: "Fixed." }], { behavior });
		expect(r.code).toBe(0);
		expect(r.requests).toHaveLength(2);
		expect(lastUserText(r.requests[1]!)).toBe(feedbackPrompt("s1", "2 tests failed"));
		expect(lastUserText(r.requests[1]!)).toBe(
			"The check for step s1 did not pass:\n2 tests failed\nContinue working. Call `submit` when the step is complete, or `report_blocked` if you cannot proceed.",
		);
		expect(ofType("check").map((e) => [e.by, e.ok])).toEqual([["runner", false], ["runner", true]]);
	});

	it("fresh_per_step saves two session files; continue saves one", async () => {
		const fresh = await run([{ tool: "submit" }], { goals: ["First", "Second"] });
		expect(fresh.code).toBe(0);
		expect(fresh.sessionFiles()).toHaveLength(2);
		toy!.cleanup();
		const cont = await run([{ tool: "submit" }, { tool: "submit" }], { goals: ["First", "Second"], options: { sessionMode: "continue" } });
		expect(cont.code).toBe(0);
		expect(cont.sessionFiles()).toHaveLength(1);
		expect(statuses()).toEqual(["passed", "passed"]);
		// The session file is named on standard output with its absolute path.
		expect(cont.out.filter((l) => l.startsWith("harness-run: session file /"))).toHaveLength(1);
	});

	it("a stop line in the control file ends the run with rule aborted_by_user, and that abort is not an interruption", async () => {
		toy = makeToyProject();
		makePlan(toy, ["First", "Second"]);
		const t = toy;
		const stopper = tool("wait_for_stop", async (signal) => {
			appendControl(controlPath(t.dir), { cmd: "stop" }, new Date());
			await until(() => signal?.aborted === true, "the runner to abort the run");
			return "aborted";
		});
		const r = await runOn(t, [{ tool: "wait_for_stop" }], { factories: [stopper] });
		expect(r.code).toBe(2);
		expect(statuses()).toEqual(["stopped", "pending"]);
		expect(ofType("rule_tripped").map((e) => [e.rule, e.action])).toEqual([["aborted_by_user", "stop"]]);
		expect(toy.readSteps().map((s) => [s.outcome, s.stop_rule, s.interruptions])).toEqual([["stopped", "aborted_by_user", 0]]);
		expect(ofType("interruption")).toEqual([]);
		expect(r.requests).toHaveLength(1);
		expect(r.err.at(-1)).toMatch(/step s1 ended stopped \(stop rule aborted_by_user: harness-ctl stop was given\)/);
	});

	it("a steer line reaches the model and is logged as an interruption with how control", async () => {
		toy = makeToyProject();
		makePlan(toy, ["First"]);
		const t = toy;
		const steerer = tool("steer_and_wait", async () => {
			appendControl(controlPath(t.dir), { cmd: "steer", text: "Use the GPU build." }, new Date());
			await until(() => t.readEvents().some((e) => e.type === "interruption"), "the steering message");
			return "waited";
		});
		const r = await runOn(t, [{ tool: "steer_and_wait" }, { tool: "submit" }], { factories: [steerer] });
		expect(r.code).toBe(0);
		expect(ofType("interruption").map((e) => [e.how, e.text_head])).toEqual([["control", "Use the GPU build."]]);
		expect(r.requests).toHaveLength(2);
		expect(r.requests[1]!.messages.some((m) => m.role === "user" && textOf(m.content) === "Use the GPU build.")).toBe(true);
		expect(toy.readSteps()[0]).toMatchObject({ outcome: "passed", interruptions: 1, interruptions_by_reason: { unlabeled: 1 } });
	});

	it("control lines written before the run started are not acted on", async () => {
		toy = makeToyProject();
		makePlan(toy, ["First"]);
		appendControl(controlPath(toy.dir), { cmd: "stop" }, new Date());
		const r = await runOn(toy, [{ tool: "submit" }]);
		expect(r.code).toBe(0);
		expect(statuses()).toEqual(["passed"]);
	});

	it("a plan file changed on disk during the run ends it with rule plan_changed_externally, keeps the edit, and marks the step stopped", async () => {
		toy = makeToyProject();
		makePlan(toy, ["First", "Second"]);
		const t = toy;
		const editor = tool("edit_plan", () => {
			const path = join(t.dir, "harness/plans/e1.json");
			const plan = JSON.parse(readFileSync(path, "utf8"));
			plan.steps[1].goal = "Second, edited by hand";
			writeFileSync(path, JSON.stringify(plan, null, 2));
			return "edited";
		});
		const r = await runOn(t, [{ tool: "edit_plan" }, { text: "Done." }], { factories: [editor] });
		expect(r.code).toBe(2);
		expect(ofType("plan_changed_externally")).not.toEqual([]);
		expect(ofType("rule_tripped").map((e) => [e.rule, e.action])).toEqual([["plan_changed_externally", "stop"]]);
		expect(toy.readEvents().filter((e) => e.type === "rule_tripped" || e.type === "step_end").map((e) => e.type)).toEqual(["rule_tripped", "step_end"]);
		expect(toy.readSteps().map((s) => [s.step, s.outcome, s.stop_rule])).toEqual([["s1", "stopped", "plan_changed_externally"]]);
		// The harness wrote the edited plan with s1 stopped: the person's edit stays.
		const plan = toy.readPlan("e1") as { steps: { status: string; goal: string; reason?: string }[] };
		expect(plan.steps.map((s) => [s.status, s.goal])).toEqual([["stopped", "First"], ["pending", "Second, edited by hand"]]);
		expect(plan.steps[0]!.reason).toMatch(/^stop rule plan_changed_externally: plan e1 was changed outside the harness/);
		// Later reads in the run took the file as it is.
		expect(ofType("plan_changed_externally")).toHaveLength(1);
		expect(r.err.at(-1)).toMatch(/step s1 ended stopped \(stop rule plan_changed_externally: plan e1 was changed outside the harness/);
	});

	it("runner checks that fail twice with the same signature stop the step by the stall rule of Step 9", async () => {
		const r = await run([{ text: "Done." }, { text: "Done again." }], { behavior: { check: [{ ok: false, summary: "T1 fails", signature: "T1" }] } });
		expect(r.code).toBe(2);
		expect(toy!.readSteps().map((s) => [s.outcome, s.stop_rule, s.check_attempts])).toEqual([["stopped", "stall", 2]]);
		expect(r.requests).toHaveLength(2);
	});

	it("check_error: a broken check stops the step, whether submit or the runner ran it", async () => {
		const broken = { check: [{ mode: "exit", code: 3 }] };
		const bySubmit = await run([{ tool: "submit" }], { behavior: broken });
		expect(bySubmit.code).toBe(2);
		expect(bySubmit.requests).toHaveLength(1); // submit ended the run.
		expect(toy!.readSteps().map((s) => [s.outcome, s.stop_rule, s.check_attempts])).toEqual([["stopped", "check_error", 0]]);
		toy!.cleanup();
		const byRunner = await run([{ text: "Done." }], { behavior: broken });
		expect(byRunner.code).toBe(2);
		expect(ofType("check").map((e) => [e.by, e.outcome])).toEqual([["runner", "script_error"]]);
		expect(toy!.readSteps().map((s) => [s.outcome, s.stop_rule])).toEqual([["stopped", "check_error"]]);
	});

	it("--steps 1 attempts one of two pending steps", async () => {
		const r = await run([{ tool: "submit" }], { goals: ["First", "Second"], options: { steps: 1 } });
		expect(r.code).toBe(0);
		expect(statuses()).toEqual(["passed", "pending"]);
	});

	it("exit 1 with a message for an unknown model, a missing plan, or an active step; exit 0 when nothing is pending", async () => {
		const unknown = await run([], { options: { model: "scripted/no-such-model" } });
		expect(unknown).toMatchObject({ code: 1, err: [expect.stringMatching(/unknown model scripted\/no-such-model/)] });
		expect(statuses()).toEqual(["pending"]);
		const t = toy!;
		expect(await runOn(t, [], { plan: "nope" })).toMatchObject({ code: 1, err: [expect.stringMatching(/no plan nope in/)] });
		expect(await runOn(t, [], { model: "scripted" })).toMatchObject({ code: 1, err: [expect.stringMatching(/--model must be <provider>\/<model id>/)] });
		const store = new PlanStore(t.dir);
		store.write(startStep(store.read("e1").plan, "s1"));
		expect(await runOn(t, [])).toMatchObject({ code: 1, err: [expect.stringMatching(/step s1 of plan e1 is already active/)] });
		toy!.cleanup();
		toy = makeToyProject();
		makePlan(toy, []);
		expect(await runOn(toy, [])).toMatchObject({ code: 0, err: [], out: ["harness-run: plan e1 has no pending step; nothing to run"] });
	});
});
