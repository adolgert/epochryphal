// Level 1 (stub): the /run-plan adapter. Starting through begin(), the refusals of /run-plan, the
// boundary at agent_settled, /stop-plan, the reset at session_start, and the harness's own aborts.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { FakeClock } from "../rig/clock.ts";
import { type ContextOptions, FakePi } from "../rig/fake-pi.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

/** A stub session on a toy project with plan e1 and pending steps s1 and s2. */
async function session(approve: "ask" | "auto" = "auto") {
	toy = makeToyProject({ config: { run_plan: { approve } } });
	const t = toy;
	const pi = new FakePi().load(createHarnessExtension({ clock: new FakeClock() }));
	const opts: ContextOptions = { cwd: t.dir };
	const start = () => pi.fire("session_start", { type: "session_start", reason: "startup" }, opts);
	await start();
	const run = async (line: string, extra: ContextOptions = {}) => {
		const [name, ...rest] = line.replace(/^\//, "").split(" ");
		await pi.runCommand(name!, rest.join(" "), { ...opts, ...extra });
	};
	await run("/plan-new e1 Goal");
	await run("/add-step measure -- First");
	await run("/add-step measure -- Second");
	/** pi begins the run of the last prompt sent. */
	const begins = async () => {
		const prompt = pi.sentUserMessages.at(-1)!.content as string;
		await pi.fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt, systemPrompt: "", systemPromptOptions: { sections: {} } }, { ...opts, idle: false });
	};
	const settled = (aborted = false, extra: ContextOptions = {}) => pi.fire("agent_settled", { type: "agent_settled", aborted }, { ...opts, ...extra });
	const submit = () => pi.callTool("submit", {}, { ...opts, idle: false });
	const statuses = () => (t.readPlan("e1") as { steps: { status: string }[] }).steps.map((s) => s.status);
	const starts = () => t.readEvents().filter((e) => e.type === "step_start").map((e) => [e.step, e.mode]);
	const said = () => pi.notifications.map((n) => n.message);
	return { pi, t, opts, start, run, begins, settled, submit, statuses, starts, said };
}

describe("/run-plan", () => {
	it("starts the first pending step through begin(): step_start in mode run_plan, then the step prompt", async () => {
		const { pi, run, starts, statuses } = await session();
		await run("/run-plan");
		expect(statuses()).toEqual(["active", "pending"]);
		expect(starts()).toEqual([["s1", "run_plan"]]);
		expect(pi.sentUserMessages).toHaveLength(1);
		expect(pi.sentUserMessages[0]!.content).toMatch(/^\[harness step s1 \| kind: measure \| plan: e1\]/);
	});

	it("after a pass, the settle starts the next step; after the last, the mode ends", async () => {
		const { pi, run, begins, settled, submit, starts, statuses, said } = await session();
		await run("/run-plan");
		await begins();
		await submit();
		await settled();
		expect(starts()).toEqual([["s1", "run_plan"], ["s2", "run_plan"]]);
		expect(pi.sentUserMessages).toHaveLength(2);
		await begins();
		await submit();
		await settled();
		expect(statuses()).toEqual(["passed", "passed"]);
		expect(said().at(-1)).toBe("run-plan ended: the plan has no pending step left. The session is supervised again.");
		// Further settles do nothing.
		await settled();
		expect(pi.sentUserMessages).toHaveLength(2);
	});

	it("refuses an invalid n, a busy agent, an active step, and a second /run-plan, before any write", async () => {
		const { pi, run, said, starts } = await session();
		await run("/run-plan 0");
		expect(said().at(-1)).toMatch(/^harness: usage: \/run-plan \[n\]/);
		await run("/run-plan", { idle: false });
		expect(said().at(-1)).toBe("harness: the agent is working; wait for it to finish, or press Escape, then try again");
		await run("/next-step");
		await run("/run-plan");
		expect(said().at(-1)).toBe("harness: step s1 is active; finish it or /abandon it, then /run-plan");
		expect(starts()).toEqual([["s1", "supervised"]]);
		await run("/abandon later");
		await run("/run-plan");
		await run("/run-plan");
		expect(said().at(-1)).toBe("harness: run-plan is already on; /stop-plan ends it after the current step");
		expect(pi.sentUserMessages).toHaveLength(2);
		expect(starts()).toEqual([["s1", "supervised"], ["s2", "run_plan"]]);
	});

	it("refuses when the plan has no pending step", async () => {
		const { run, said, submit, begins, settled } = await session();
		await run("/run-plan");
		await begins();
		await submit();
		await settled();
		await begins();
		await submit();
		await settled();
		await run("/run-plan");
		expect(said().at(-1)).toBe("harness: plan e1 has no pending step; add some with /add-step");
	});

	it("a refused start at the boundary (protected files changed) ends the mode with the reason and writes nothing", async () => {
		const { t, run, begins, settled, submit, starts, statuses, said } = await session();
		await run("/run-plan");
		await begins();
		await submit();
		mkdirSync(join(t.dir, "tests"), { recursive: true });
		writeFileSync(join(t.dir, "tests", "new.txt"), "x");
		await settled();
		expect(statuses()).toEqual(["passed", "pending"]);
		expect(starts()).toEqual([["s1", "run_plan"]]);
		expect(said().at(-1)).toBe("harness: run-plan ended: protected files have uncommitted changes: tests/new.txt; commit or restore them before starting a step. The session is supervised again.");
	});

	it("a settle while the step's prompt has not begun its run is not a boundary", async () => {
		const { pi, run, begins, settled, submit, statuses } = await session();
		await run("/run-plan");
		await settled(); // Some other run settled before the step's run began.
		await begins();
		await submit();
		await settled();
		expect(statuses()).toEqual(["passed", "active"]);
		expect(pi.sentUserMessages).toHaveLength(2);
	});

	it("approve ask asks with continue / stop / stop and edit; Escape counts as stop", async () => {
		const { pi, run, begins, settled, submit, statuses, said } = await session("ask");
		await run("/run-plan");
		await begins();
		await submit();
		await settled(false, { ui: { select: [undefined] } });
		expect(pi.dialogs).toEqual([{ kind: "select", title: expect.stringMatching(/^Step s1 passed: First\n[\s\S]*\n\nStart s2\?$/), message: ["Continue", "Stop", "Stop and edit the plan"] }]);
		expect(statuses()).toEqual(["passed", "pending"]);
		expect(said().at(-1)).toBe("run-plan ended: you chose stop. The session is supervised again.");
	});
});

describe("/stop-plan", () => {
	it("is harmless when the mode is off", async () => {
		const { run, said, statuses } = await session();
		await run("/stop-plan");
		expect(said().at(-1)).toBe("run-plan is not on; nothing to stop.");
		expect(statuses()).toEqual(["pending", "pending"]);
	});

	it("lets the current step finish, then ends the mode instead of starting the next", async () => {
		const { pi, run, begins, settled, submit, statuses, said } = await session();
		await run("/run-plan");
		await begins();
		await run("/stop-plan", { idle: false });
		expect(statuses()).toEqual(["active", "pending"]);
		await submit();
		await settled();
		expect(statuses()).toEqual(["passed", "pending"]);
		expect(pi.sentUserMessages).toHaveLength(1);
		expect(said().at(-1)).toBe("run-plan ended: /stop-plan was given. The session is supervised again.");
	});
});

describe("aborts and restarts", () => {
	it("/abandon during the mode (the harness's own abort) ends the mode", async () => {
		const { pi, run, begins, settled, statuses, said } = await session();
		await run("/run-plan");
		await begins();
		await run("/abandon too slow", { idle: false });
		await settled(true);
		expect(statuses()).toEqual(["abandoned", "pending"]);
		expect(pi.sentUserMessages).toHaveLength(1);
		expect(said().at(-1)).toBe("harness: run-plan ended: step s1 ended abandoned: too slow. The session is supervised again.");
	});

	it("an aborted run whose step passed does not continue", async () => {
		const { pi, run, begins, settled, submit, statuses } = await session();
		await run("/run-plan");
		await begins();
		await submit();
		await settled(true);
		expect(statuses()).toEqual(["passed", "pending"]);
		expect(pi.sentUserMessages).toHaveLength(1);
	});

	it("a second session_start resets the mode: no continuation, and later steps start supervised", async () => {
		const { pi, run, start, begins, settled, submit, starts } = await session();
		await run("/run-plan");
		await start();
		await begins();
		await submit();
		await settled();
		expect(pi.sentUserMessages).toHaveLength(1);
		await run("/next-step");
		expect(starts()).toEqual([["s1", "run_plan"], ["s2", "supervised"]]);
	});
});
