// Level 1 (stub): the plan and step commands, the system-prompt line, and restoring state.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { FakeClock } from "../rig/clock.ts";
import { type ContextOptions, FakePi } from "../rig/fake-pi.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

/** A stub pi with the harness loaded and a session started in `cwd`. */
async function session(t: ToyProject, cwd = t.dir, sessionId = "sess-1"): Promise<{ pi: FakePi; run: (cmd: string, opts?: ContextOptions) => Promise<void> }> {
	const pi = new FakePi().load(createHarnessExtension({ clock: new FakeClock() }));
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, { cwd, sessionId });
	const run = async (line: string, opts: ContextOptions = {}) => {
		const [name, ...rest] = line.replace(/^\//, "").split(" ");
		await pi.runCommand(name!, rest.join(" "), { cwd, sessionId, ...opts });
	};
	return { pi, run };
}

/** What before_agent_start leaves in the system prompt sections. */
async function sections(pi: FakePi): Promise<Record<string, string>> {
	const event = { type: "before_agent_start", messageType: "user", prompt: "p", systemPrompt: "", systemPromptOptions: { sections: { other: "kept" } as Record<string, string> } };
	await pi.fire("before_agent_start", event);
	return event.systemPromptOptions.sections;
}

const errors = (pi: FakePi) => pi.notifications.filter((n) => n.type === "error").map((n) => n.message);

describe("plan commands", () => {
	it("/plan-new creates the plan file and makes it active", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Run the solve on the GPU");
		expect(toy.readPlan("e1")).toMatchObject({ plan_id: "e1", goal: "Run the solve on the GPU", steps: [], exit: null });
		expect(readFileSync(join(toy.dir, "harness/plans/ACTIVE"), "utf8")).toBe("e1\n");
		expect(errors(pi)).toEqual([]);
	});

	it("/plan-use switches the active plan; an unknown plan is refused", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 First");
		await run("/plan-new e2 Second");
		await run("/plan-use e1");
		expect(readFileSync(join(toy.dir, "harness/plans/ACTIVE"), "utf8")).toBe("e1\n");
		await run("/plan-use e9");
		expect(errors(pi)).toEqual([expect.stringMatching(/harness: no plan e9/)]);
	});

	it("/plan-status shows the goal, each step, and the active step's usage against its budget", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Run the solve on the GPU");
		await run("/add-step offload R17 -- Port R17");
		await run("/step measure -- Profile it");
		pi.notifications.length = 0;
		await run("/plan-status");
		expect(pi.notifications).toEqual([
			{
				type: "info",
				message: [
					"Plan e1: Run the solve on the GPU",
					"  s1 pending   offload [R17]: Port R17",
					"  s2 active    measure: Profile it",
					"Usage of s2: 0 of 1000000 tokens, $0 of $10, 0 of 60 agent minutes, 0 of 5 check attempts",
				].join("\n"),
			},
		]);
	});

	it("/plan-close records the decision and is refused while a step is active", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/step measure -- Profile it");
		await run("/plan-close keep looks good");
		expect(errors(pi)).toEqual([expect.stringMatching(/step s1 is active; finish it or \/abandon it before closing the plan/)]);
		await run("/abandon not needed");
		await run("/plan-close revert slower than the CPU");
		expect(toy.readPlan("e1")).toMatchObject({ exit: { decision: "revert", note: "slower than the CPU", at: "2026-11-10T14:00:00.000Z" } });
		await run("/plan-close keep second thoughts");
		expect(errors(pi).at(-1)).toMatch(/plan e1 is closed/);
	});
});

describe("step commands", () => {
	it("/step appends a step, starts it, logs step_start, and sends the exact step prompt", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Run the solve on the GPU");
		await run("/step offload R17 -- Port region R17");
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ id: "s1", kind: "offload", check_args: ["R17"], status: "active", attempt: 1 }] });
		expect(pi.sentUserMessages).toEqual([
			{
				content: [
					"[harness step s1 | kind: offload | plan: e1]",
					"Epoch goal: Run the solve on the GPU",
					"Step goal: Port region R17",
					"You are finished only when the `submit` tool passes. If you cannot proceed, call",
					"`report_blocked` with the reason. Do not change files under: harness/harness.json, harness/scripts/**, harness/lessons/**, tests/**.",
				].join("\n"),
				options: undefined,
			},
		]);
		expect(toy.readEvents().at(-1)).toMatchObject({ type: "step_start", plan: "e1", step: "s1", attempt: 1, kind: "offload", goal: "Port region R17", origin: "user" });
	});

	it("/add-step appends without starting; /next-step starts the first pending step", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/add-step measure Profile it");
		await run("/add-step offload R17 -- Port R17");
		expect(pi.sentUserMessages).toHaveLength(0);
		await run("/next-step");
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ status: "active" }, { status: "pending" }] });
		expect(pi.sentUserMessages).toHaveLength(1);
	});

	it("refuses to start a step while another is active, or while the agent is working", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/step measure -- One");
		await run("/step measure -- Two");
		await run("/abandon wrong");
		await run("/add-step measure -- Three");
		await run("/next-step", { idle: false });
		expect(errors(pi)).toEqual([
			expect.stringMatching(/step s1 is active; finish it or \/abandon it first/),
			expect.stringMatching(/the agent is working/),
		]);
		expect(pi.sentUserMessages).toHaveLength(1);
	});

	it("/abandon ends the active step with its reason and logs step_end", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/step measure -- Profile it");
		await run("/abandon too slow");
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ status: "abandoned", reason: "too slow" }] });
		expect(toy.readEvents().at(-1)).toMatchObject({ type: "step_end", step: "s1", outcome: "abandoned", detail: "too slow" });
		await run("/abandon again");
		expect(errors(pi)).toEqual([expect.stringMatching(/no step is active/)]);
	});

	it("/retry-step restarts the latest abandoned step with attempt 2", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/step measure -- Profile it");
		await run("/abandon too slow");
		await run("/retry-step");
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ status: "active", attempt: 2 }] });
		expect(toy.readEvents().at(-1)).toMatchObject({ type: "step_start", step: "s1", attempt: 2 });
		expect(pi.sentUserMessages).toHaveLength(2);
	});

	it("reports bad arguments and a missing plan without changing anything", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/step measure -- Profile it");
		await run("/plan-new e1 Goal");
		await run("/step tune -- Make it fast");
		await run("/step offload R17 --");
		expect(errors(pi)).toEqual([
			expect.stringMatching(/no active plan; create one with \/plan-new/),
			expect.stringMatching(/unknown kind "tune"/),
			expect.stringMatching(/the step needs a goal/),
		]);
		expect(toy.readPlan("e1")).toMatchObject({ steps: [] });
	});

	it("refuses every command when the harness is inactive", async () => {
		toy = makeToyProject();
		const elsewhere = join(toy.workDir, "elsewhere");
		mkdirSync(elsewhere);
		const { pi, run } = await session(toy, elsewhere);
		const lines = ["/plan-new e1 Goal", "/plan-use e1", "/plan-status", "/plan-close keep done", "/step measure -- g", "/add-step measure -- g", "/next-step", "/retry-step"];
		for (const line of lines) await expect(run(line)).resolves.toBeUndefined();
		expect(errors(pi)).toEqual(lines.map(() => expect.stringMatching(/harness inactive/)));
		await expect(run("/abandon reason")).resolves.toBeUndefined();
		expect(errors(pi).at(-1)).toMatch(/harness inactive|no step is active/);
		expect(errors(pi)).toHaveLength(lines.length + 1);
	});

	for (const [name, setup, before] of [
		["/next-step", ["/add-step measure -- Profile it"], { status: "pending", attempt: 1 }],
		["/retry-step", ["/step measure -- Profile it", "/abandon too slow"], { status: "abandoned", attempt: 1 }],
	] as const) {
		it(`${name} with a broken harness.json changes nothing`, async () => {
			toy = makeToyProject();
			const { pi, run } = await session(toy);
			await run("/plan-new e1 Goal");
			for (const line of setup) await run(line);
			const events = toy.readEvents().length;
			const sent = pi.sentUserMessages.length;
			writeFileSync(join(toy.dir, "harness/harness.json"), "{ not json");
			await run(name);
			expect(toy.readPlan("e1")).toMatchObject({ steps: [before] });
			expect(toy.readEvents()).toHaveLength(events);
			expect(pi.sentUserMessages).toHaveLength(sent);
			expect(errors(pi)).toHaveLength(1);
			expect(await sections(pi)).toEqual({ other: "kept" });
		});
	}

	it("/abandon while the agent is working aborts it, waits for idle, then ends the step", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/step measure -- Profile it");
		await run("/abandon too slow", { idle: false });
		expect(pi.agentCalls).toEqual(["abort", "waitForIdle"]);
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ status: "abandoned", reason: "too slow" }] });
		expect(toy.readEvents().at(-1)).toMatchObject({ type: "step_end", step: "s1", outcome: "abandoned" });
		await run("/step measure -- Again");
		await run("/abandon idle now");
		expect(pi.agentCalls).toEqual(["abort", "waitForIdle"]);
		expect(errors(pi)).toEqual([]);
	});

	it("/plan-status on a hand-edited plan with a null proposal reports an error", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		const path = join(toy.dir, "harness/plans/e1.json");
		writeFileSync(path, readFileSync(path, "utf8").replace('"proposals": []', '"proposals": [null]'));
		await expect(run("/plan-status")).resolves.toBeUndefined();
		expect(errors(pi)).toEqual([expect.stringMatching(/proposals\[0\] must be an object/)]);
	});

	/** Plan e1 with s1 abandoned and s2 pending, then edited by hand: s2 removed, goal changed. */
	async function handEdited(t: ToyProject) {
		const ctx = await session(t);
		await ctx.run("/plan-new e1 Goal");
		await ctx.run("/step measure -- One");
		await ctx.run("/abandon wrong");
		await ctx.run("/add-step measure -- Two");
		const path = join(t.dir, "harness/plans/e1.json");
		const plan = JSON.parse(readFileSync(path, "utf8"));
		plan.goal = "Edited goal";
		plan.steps = [{ ...plan.steps[0], status: "pending", reason: undefined }];
		writeFileSync(path, JSON.stringify(plan, null, 2));
		return ctx;
	}

	it("asks before using a plan edited by hand, showing the change in steps and statuses", async () => {
		toy = makeToyProject();
		const { pi, run } = await handEdited(toy);
		await run("/next-step", { ui: { confirm: [true] } });
		expect(pi.dialogs).toEqual([
			{ kind: "confirm", title: "Plan e1 was changed outside the harness", message: "steps: 2 -> 1; s1: abandoned -> pending; s2 removed (was pending)\nUse the plan file as it is now?" },
		]);
		expect(String(pi.sentUserMessages.at(-1)!.content)).toMatch(/Epoch goal: Edited goal/);
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ id: "s1", status: "active" }] });
		await run("/plan-status");
		expect(pi.dialogs).toHaveLength(1);
	});

	it("changes nothing when the person refuses a plan edited by hand, and asks again next time", async () => {
		toy = makeToyProject();
		const { pi, run } = await handEdited(toy);
		const before = readFileSync(join(toy.dir, "harness/plans/e1.json"), "utf8");
		const events = toy.readEvents().length;
		const sent = pi.sentUserMessages.length;
		await run("/next-step", { ui: { confirm: [false] } });
		expect(readFileSync(join(toy.dir, "harness/plans/e1.json"), "utf8")).toBe(before);
		expect(toy.readEvents()).toHaveLength(events);
		expect(pi.sentUserMessages).toHaveLength(sent);
		expect(errors(pi)).toEqual([expect.stringMatching(/the change to plan e1 was not accepted; nothing was done/)]);
		await run("/plan-status", { ui: { confirm: [false] } });
		expect(pi.dialogs).toHaveLength(2);
	});

	it("without a user interface refuses a plan edited by hand and logs plan_changed_externally", async () => {
		toy = makeToyProject();
		const { pi, run } = await handEdited(toy);
		const before = readFileSync(join(toy.dir, "harness/plans/e1.json"), "utf8");
		const sent = pi.sentUserMessages.length;
		await run("/next-step", { hasUI: false });
		expect(readFileSync(join(toy.dir, "harness/plans/e1.json"), "utf8")).toBe(before);
		expect(pi.sentUserMessages).toHaveLength(sent);
		expect(toy.readEvents().at(-1)).toMatchObject({ type: "plan_changed_externally", plan: "e1" });
		expect(toy.readEvents().filter((e) => e.type === "step_start")).toHaveLength(1);
	});

	it("/plan-use accepts the file as it is", async () => {
		toy = makeToyProject();
		const { pi, run } = await handEdited(toy);
		await run("/plan-use e1");
		await run("/next-step");
		expect(pi.dialogs).toEqual([]);
		expect(toy.readPlan("e1")).toMatchObject({ steps: [{ id: "s1", status: "active" }] });
	});

	for (const [name, setup] of [
		["/next-step", ["/add-step offload R17 -- Port R17"]],
		["/retry-step", ["/step offload R17 -- Port R17", "/abandon later"]],
	] as const) {
		it(`${name} refuses a step whose kind harness.json no longer defines, before any write`, async () => {
			toy = makeToyProject();
			const { pi, run } = await session(toy);
			await run("/plan-new e1 Goal");
			for (const line of setup) await run(line);
			const plan = readFileSync(join(toy.dir, "harness/plans/e1.json"), "utf8");
			const events = toy.readEvents().length;
			const sent = pi.sentUserMessages.length;
			const config = toy.readConfig() as { kinds: Record<string, unknown> };
			delete config.kinds.offload;
			writeFileSync(join(toy.dir, "harness/harness.json"), JSON.stringify(config));
			await run(name);
			expect(errors(pi)).toEqual([expect.stringMatching(/step s1 has kind "offload", which harness.json no longer defines/)]);
			expect(readFileSync(join(toy.dir, "harness/plans/e1.json"), "utf8")).toBe(plan);
			expect(toy.readEvents()).toHaveLength(events);
			expect(pi.sentUserMessages).toHaveLength(sent);
			expect(await sections(pi)).toEqual({ other: "kept" });
		});
	}
});

describe("system-prompt line and restore", () => {
	it("adds the active-step line while a step is active and removes it afterwards", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		expect(await sections(pi)).toEqual({ other: "kept" });
		await run("/step measure -- Profile it");
		expect(await sections(pi)).toEqual({ other: "kept", harness: "Active harness step s1: Profile it. Finish with submit or report_blocked." });
		await run("/abandon done with it");
		expect(await sections(pi)).toEqual({ other: "kept" });
	});

	it("restores the active step in a new session, and logs it with the step", async () => {
		toy = makeToyProject();
		const first = await session(toy);
		await first.run("/plan-new e1 Goal");
		await first.run("/step measure -- Profile it");
		const second = await session(toy, toy.dir, "sess-2");
		expect((await sections(second.pi)).harness).toMatch(/^Active harness step s1/);
		await second.run("/abandon restarted");
		expect(toy.readEvents().at(-1)).toMatchObject({ session: "sess-2", step: "s1", type: "step_end" });
	});

	it("rebuilds state when the same extension instance sees a second session_start", async () => {
		toy = makeToyProject();
		const { pi, run } = await session(toy);
		await run("/plan-new e1 Goal");
		await run("/step measure -- Profile it");
		const elsewhere = join(toy.workDir, "elsewhere");
		mkdirSync(elsewhere);
		await pi.fire("session_start", { type: "session_start", reason: "resume" }, { cwd: elsewhere, sessionId: "sess-9" });
		expect((await sections(pi)).harness).toBeUndefined();
		await pi.fire("session_start", { type: "session_start", reason: "resume" }, { cwd: toy.dir, sessionId: "sess-10" });
		expect((await sections(pi)).harness).toMatch(/^Active harness step s1/);
		expect(toy.readEvents().filter((e) => e.type === "session_start").map((e) => [e.session, e.reason])).toEqual([
			["sess-1", "startup"],
			["sess-10", "resume"],
		]);
	});
});
