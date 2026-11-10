// Level 2: interruptions, /why, /abandon during a run, and step records in a real pi session.
// The steer test is the drift test for `input`; the abort test is the drift test for `agent_settled`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptEntry } from "../rig/script.ts";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";
import { type Behavior, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let s: SdkSession | undefined;
let toy: ToyProject | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
	toy?.cleanup();
	toy = undefined;
});

/** Waits until the signal is aborted. */
const aborted = (signal: AbortSignal | undefined) =>
	new Promise<void>((resolve) => {
		if (!signal || signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});

/**
 * A tool named `gate` that, while it runs, calls `during` and waits for what it returns. The test
 * acts in the middle of a tool call without depending on timing.
 */
const gate = (during: (signal: AbortSignal | undefined) => Promise<unknown> | unknown) => (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "gate",
		label: "Gate",
		description: "Test tool.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			await during(signal);
			return { content: [{ type: "text", text: signal?.aborted ? "gate aborted" : "gate done" }], details: undefined };
		},
	});
};

/** A session with plan e1 in which `/step measure -- Profile it` runs `script`. */
async function stepWith(script: ScriptEntry[], during: Parameters<typeof gate>[0], behavior: Behavior = {}): Promise<SdkSession> {
	s = await runSdkSession({ project: makeToyProject({ behavior }), script, factories: [gate(during)] });
	await s.prompt("/plan-new e1 Goal");
	await s.prompt("/step measure -- Profile it");
	return s;
}

const ofType = (session: SdkSession, type: string) => session.project.readEvents().filter((e) => e.type === type);

describe("interruptions in a real session", () => {
	it("[drift] input: a steering message during a run writes an interruption with how steer", async () => {
		const t = await stepWith([{ tool: "gate", args: {} }, { text: "ok" }], () => s!.session.steer("use the GPU build"));
		expect(ofType(t, "interruption")).toEqual([
			expect.objectContaining({ step: "s1", how: "steer", text_head: "use the GPU build", reason: null, label_of: null }),
		]);
		expect(JSON.stringify(t.requests()[1]?.messages)).toContain("use the GPU build");
	});

	it("[drift] agent_settled: an aborted run writes an interruption with how abort, and the aborted tool call is still logged", async () => {
		const t = await stepWith([{ tool: "gate", args: {} }, { text: "never requested" }], (signal) => {
			void s!.session.abort();
			return aborted(signal);
		});
		expect(ofType(t, "interruption")).toEqual([expect.objectContaining({ step: "s1", how: "abort", text_head: null })]);
		// Probe for docs/pi-facts.md: an abort in the middle of a tool call still emits tool_execution_end.
		expect(ofType(t, "tool_call")).toEqual([expect.objectContaining({ tool: "gate", parent: null, duration_ms: expect.any(Number) })]);
		expect(t.requests()).toHaveLength(1);
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }] });
	});

	it("/why labels the latest interruption, and the step record counts it under its reason", async () => {
		const t = await stepWith(
			[{ tool: "gate", args: {} }, { text: "ok" }, { tool: "submit", args: {} }, { text: "done" }],
			() => s!.session.steer("look at the COMMON blocks"),
			{ check: [{ ok: true, summary: "profile recorded" }] },
		);
		await t.prompt("/why missing-info COMMON block layout");
		expect(ofType(t, "interruption").at(-1)).toMatchObject({ how: "steer", reason: "missing-info", note: "COMMON block layout", label_of: 1 });
		await t.prompt("Now submit."); // Typed while idle with the step active: a second interruption.
		expect(ofType(t, "interruption").at(-1)).toMatchObject({ how: "idle_message", text_head: "Now submit.", label_of: null });
		expect(t.project.readSteps()).toEqual([
			expect.objectContaining({ step: "s1", outcome: "passed", interruptions: 2, interruptions_by_reason: { "missing-info": 1, unlabeled: 1 } }),
		]);
	});

	it("/abandon while a tool runs aborts the run, ends the step, and is not an interruption", async () => {
		let abandoning: Promise<void> | undefined;
		const t = await stepWith([{ tool: "gate", args: {} }, { text: "never requested" }], (signal) => {
			// Extension commands run at once, even during a run (agent-session.js prompt()).
			abandoning = s!.session.prompt("/abandon too slow");
			return aborted(signal);
		});
		await abandoning;
		expect(t.project.readPlan("e1")).toMatchObject({ steps: [{ status: "abandoned", reason: "too slow" }] });
		expect(ofType(t, "interruption")).toEqual([]);
		expect(ofType(t, "tool_call")).toEqual([expect.objectContaining({ tool: "gate" })]);
		expect(t.requests()).toHaveLength(1);
		expect(t.project.readSteps()).toEqual([expect.objectContaining({ step: "s1", outcome: "abandoned", reason: "too slow", interruptions: 0, model_calls: 1 })]);
	});

	it("/abandon sent right after /step, before the step's run has begun, keeps that run from reaching the model", async () => {
		s = await runSdkSession({ script: [{ text: "working" }] });
		await s.prompt("/plan-new e1 Goal");
		// session.prompt() returns before the run the command asked for (docs/pi-facts.md, change 5).
		await s.session.prompt("/step measure -- Profile it");
		await s.session.prompt("/abandon changed my mind");
		await s.settle();
		expect(s.project.readPlan("e1")).toMatchObject({ steps: [{ status: "abandoned" }] });
		expect(s.requests()).toEqual([]);
		expect(ofType(s, "interruption")).toEqual([]);
		expect(s.project.readSteps()).toEqual([expect.objectContaining({ outcome: "abandoned", model_calls: 0 })]);
		await s.prompt("hello"); // The session still works afterwards.
		expect(s.requests()).toHaveLength(1);
	});
});

describe("step records in a real session", () => {
	it("a passed step has a step record with outcome passed and the usage of its model calls", async () => {
		s = await runSdkSession({ project: makeToyProject({ behavior: { check: [{ ok: true, summary: "profile recorded" }] } }), script: [{ tool: "submit", args: {} }, { text: "done" }] });
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("/step measure -- Profile it");
		expect(s.project.readSteps()).toEqual([
			expect.objectContaining({
				plan: "e1",
				step: "s1",
				attempt: 1,
				kind: "measure",
				origin: "user",
				mode: "supervised",
				outcome: "passed",
				stop_rule: null,
				reason: null,
				interruptions: 0,
				interruptions_by_reason: {},
				check_attempts: 1,
				script_failures: 0,
				tokens: 110,
				cost_usd: 0.0015,
				wait_minutes: 0,
				model_calls: 1,
			}),
		]);
	});

	it("report_blocked writes a step record with outcome blocked and the reason", async () => {
		s = await runSdkSession({ script: [{ tool: "report_blocked", args: { reason: "no profiler" } }, { text: "stopped" }] });
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("/step measure -- Profile it");
		expect(s.project.readSteps()).toEqual([expect.objectContaining({ outcome: "blocked", reason: "no profiler", check_attempts: 0 })]);
	});

	it("a step that ends in a later session counts the work done before the restart", async () => {
		toy = makeToyProject({ behavior: { check: [{ ok: false, summary: "not yet", signature: "T1" }, { ok: true, summary: "ok" }] } });
		s = await runSdkSession({ project: toy, script: [{ tool: "submit", args: {} }, { text: "will continue" }] });
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("/step measure -- Profile it");
		await s.dispose();
		s = await runSdkSession({ project: toy, script: [{ tool: "submit", args: {} }, { text: "done" }] });
		await s.prompt("Carry on."); // An idle message to the active step.
		expect(toy.readSteps()).toEqual([
			expect.objectContaining({ outcome: "passed", check_attempts: 2, model_calls: 3, tokens: 330, interruptions: 1, interruptions_by_reason: { unlabeled: 1 } }),
		]);
	});
});
