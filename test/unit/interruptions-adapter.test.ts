// Level 1 (stub): interruptions from `input` and `agent_settled`, /why, and the step record at a
// step's end.
import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { FakeClock } from "../rig/clock.ts";
import { type ContextOptions, FakePi } from "../rig/fake-pi.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

async function session(withStep = true) {
	toy = makeToyProject();
	const t = toy;
	const pi = new FakePi().load(createHarnessExtension({ clock: new FakeClock() }));
	const ctx = { cwd: t.dir };
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	const run = (line: string, opts: ContextOptions = {}) => {
		const [name, ...rest] = line.replace(/^\//, "").split(" ");
		return pi.runCommand(name!, rest.join(" "), { ...ctx, ...opts });
	};
	await run("/plan-new e1 Goal");
	if (withStep) await run("/step measure -- Profile it");
	const input = (text: string, source: string, streamingBehavior?: string, opts: ContextOptions = {}) =>
		pi.fire("input", { type: "input", text, source, streamingBehavior }, { ...ctx, ...opts });
	const settled = (aborted: boolean) => pi.fire("agent_settled", { type: "agent_settled", aborted }, ctx);
	const interruptions = () => t.readEvents().filter((e) => e.type === "interruption");
	const errors = () => pi.notifications.filter((n) => n.type === "error").map((n) => n.message);
	return { pi, t, run, input, settled, interruptions, errors };
}

describe("interruptions", () => {
	it("an input from the person during an active step writes an interruption", async () => {
		const { input, interruptions } = await session();
		await input("x".repeat(300), "interactive", undefined);
		await input("go left", "interactive", "steer", { idle: false });
		await input("then right", "interactive", "followUp", { idle: false });
		expect(interruptions().map((e) => [e.step, e.how, String(e.text_head).length, e.label_of])).toEqual([
			["s1", "idle_message", 200, null],
			["s1", "steer", 7, null],
			["s1", "follow_up", 10, null],
		]);
	});

	it("an input from the extension does not; neither does one with no active step", async () => {
		const a = await session();
		await a.input("[harness step s1 ...]", "extension");
		expect(a.interruptions()).toEqual([]);
		a.t.cleanup();
		const b = await session(false);
		await b.input("hello", "interactive");
		expect(b.interruptions()).toEqual([]);
	});

	it("an rpc input is a control message, except in pi's own rpc mode", async () => {
		const { input, interruptions } = await session();
		await input("from the runner", "rpc", "steer", { hasUI: false, mode: "print" });
		await input("from an rpc client", "rpc", "steer", { mode: "rpc" });
		expect(interruptions().map((e) => e.how)).toEqual(["control", "steer"]);
	});

	it("an aborted run during an active step is an abort interruption; a normal end is not", async () => {
		const { settled, interruptions } = await session();
		await settled(false);
		await settled(true);
		expect(interruptions()).toEqual([expect.objectContaining({ how: "abort", text_head: null, step: "s1" })]);
	});

	it("the abort that /abandon issues is not an interruption", async () => {
		const { pi, run, settled, interruptions, t } = await session();
		await run("/abandon too slow", { idle: false });
		await settled(true); // In pi this fires inside waitForIdle; the step has ended by now here.
		expect(pi.agentCalls).toEqual(["abort", "waitForIdle"]);
		expect(interruptions()).toEqual([]);
		expect(t.readSteps()).toEqual([expect.objectContaining({ step: "s1", outcome: "abandoned", reason: "too slow", interruptions: 0 })]);
	});

	it("a step ended before its prompt's run began has that run aborted in before_agent_start", async () => {
		const { pi, run } = await session();
		const prompt = pi.sentUserMessages[0]!.content as string;
		await run("/abandon changed my mind"); // Idle: the run has not begun.
		expect(pi.agentCalls).toEqual([]);
		const event = { type: "before_agent_start", messageType: "user", prompt, systemPrompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
		await pi.fire("before_agent_start", event);
		expect(pi.agentCalls).toEqual(["abort"]);
		expect(event.systemPromptOptions.sections).toEqual({});
		// Only once: a later run with the same text is not touched.
		await pi.fire("before_agent_start", event);
		expect(pi.agentCalls).toEqual(["abort"]);
	});

	it("the step's own run is not aborted when the step is still active", async () => {
		const { pi } = await session();
		const prompt = pi.sentUserMessages[0]!.content as string;
		const event = { type: "before_agent_start", messageType: "user", prompt, systemPrompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
		await pi.fire("before_agent_start", event);
		expect(pi.agentCalls).toEqual([]);
		expect(event.systemPromptOptions.sections.harness).toMatch(/Active harness step s1/);
	});
});

describe("/why", () => {
	it("labels the latest interruption with a reason and a note", async () => {
		const { pi, input, run, interruptions } = await session();
		await input("first", "interactive", "steer", { idle: false });
		await input("second", "interactive");
		await run("/why missing-info COMMON block layout");
		expect(interruptions().at(-1)).toMatchObject({ how: "idle_message", reason: "missing-info", note: "COMMON block layout", label_of: 2, text_head: null });
		await run("/why other");
		expect(interruptions().at(-1)).toMatchObject({ reason: "other", note: null, label_of: 2 });
		expect(pi.notifications.at(-1)).toEqual({ type: "info", message: "Interruption 2 of step s1 (idle_message) labeled other." });
	});

	it("refuses an unknown reason, a step with no interruption, and no active step", async () => {
		const { run, errors, interruptions } = await session();
		await run("/why bored");
		await run("/why");
		await run("/why other");
		await run("/abandon done");
		await run("/why other");
		expect(errors()).toEqual([
			expect.stringMatching(/the reason must be one of wrong-direction, missing-info, environment, too-slow, other/),
			expect.stringMatching(/usage: \/why </),
			expect.stringMatching(/step s1 has no interruption to label/),
			expect.stringMatching(/no step is active; \/why labels interruptions of the active step/),
		]);
		expect(interruptions()).toEqual([]);
	});
});

describe("step records", () => {
	it("every way a step ends writes one step record: submit, report_blocked, and /abandon", async () => {
		const { pi, run, t } = await session();
		t.setBehavior({ check: [{ ok: true, summary: "fine" }] });
		await pi.callTool("submit", {}, { cwd: t.dir });
		await run("/step measure -- Again");
		await pi.callTool("report_blocked", { reason: "stuck" }, { cwd: t.dir });
		await run("/step measure -- Once more");
		await run("/abandon enough");
		expect(t.readSteps().map((r) => [r.step, r.outcome, r.reason, r.check_attempts])).toEqual([
			["s1", "passed", null, 1],
			["s2", "blocked", "stuck", 0],
			["s3", "abandoned", "enough", 0],
		]);
	});

	it("a step record that cannot be written is reported, and the step still ends", async () => {
		const { pi, run, t } = await session();
		mkdirSync(`${t.dir}/harness/log/steps.jsonl`); // A directory where the file should be.
		await run("/abandon enough");
		expect(t.readPlan("e1")).toMatchObject({ steps: [{ status: "abandoned" }] });
		expect(pi.notifications.filter((n) => n.type === "error").map((n) => n.message)).toEqual([expect.stringMatching(/cannot write the step record to .*steps\.jsonl.*The step still ended as abandoned/)]);
	});
});
