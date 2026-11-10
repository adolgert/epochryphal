// Level 1 (stub): propose_step, /proposals, /accept-step, and /reject-step.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Plan } from "../../src/core/plan.ts";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { FakeClock } from "../rig/clock.ts";
import { type ContextOptions, FakePi } from "../rig/fake-pi.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

async function session(t: ToyProject) {
	const pi = new FakePi().load(createHarnessExtension({ clock: new FakeClock() }));
	const opts: ContextOptions = { cwd: t.dir, sessionId: "sess-1" };
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, opts);
	const run = async (line: string, extra: ContextOptions = {}) => {
		const [name, ...rest] = line.replace(/^\//, "").split(" ");
		await pi.runCommand(name!, rest.join(" "), { ...opts, ...extra });
	};
	const tool = (name: string, params: unknown, extra: ContextOptions = {}) => pi.callTool(name, params, { ...opts, ...extra });
	const propose = (params: Record<string, unknown> = {}, extra: ContextOptions = {}) =>
		tool("propose_step", { kind: "offload", goal: "Keep R17 on the device", check_args: ["R17"], rationale: "Repeated copies", ...params }, extra);
	return { pi, run, tool, propose };
}

/** A toy project with plan e1 and a session. */
async function withPlan() {
	toy = makeToyProject();
	const s = await session(toy);
	await s.run("/plan-new e1 Goal");
	return s;
}

const errors = (pi: FakePi) => pi.notifications.filter((n) => n.type === "error").map((n) => n.message);
const infos = (pi: FakePi) => pi.notifications.filter((n) => n.type === "info").map((n) => n.message);
const readPlan = (t: ToyProject) => t.readPlan("e1") as Plan;
const planText = (t: ToyProject) => readFileSync(join(t.dir, "harness/plans/e1.json"), "utf8");
const proposalEvents = (t: ToyProject) => t.readEvents().filter((e) => e.type === "proposal");

/** What changes when a command is refused: the plan text, the events, and the messages sent. */
function snapshot(pi: FakePi, t: ToyProject) {
	return { plan: planText(t), events: t.readEvents().length, sent: pi.sentUserMessages.length };
}

describe("propose_step", () => {
	it("is registered as a sequential tool", async () => {
		const pi = new FakePi().load(createHarnessExtension());
		expect(pi.tools.get("propose_step")?.executionMode).toBe("sequential");
	});

	it("during a step: stores an open proposal from that step, logs it, creates no step, and does not end the run", async () => {
		const { pi, run, propose } = await withPlan();
		await run("/step measure -- Profile it");
		const result = await propose();
		expect(result.isError).toBeFalsy();
		expect(result.terminate).toBeFalsy();
		expect(pi.textOf(result)).toBe("Recorded proposal p1. It is not a step: a person will accept or reject it. Carry on with your current work.");
		const plan = readPlan(toy!);
		expect(plan.steps).toHaveLength(1);
		expect(plan.proposals).toEqual([
			{ id: "p1", kind: "offload", goal: "Keep R17 on the device", check_args: ["R17"], rationale: "Repeated copies", proposed_in_step: "s1", state: "open" },
		]);
		expect(proposalEvents(toy!)).toEqual([expect.objectContaining({ proposal_id: "p1", action: "proposed", step: "s1" })]);
	});

	it("with no active step: records proposed_in_step null", async () => {
		const { propose } = await withPlan();
		await propose({ check_args: undefined });
		expect(readPlan(toy!).proposals).toEqual([expect.objectContaining({ id: "p1", check_args: [], proposed_in_step: null })]);
		expect(proposalEvents(toy!)).toEqual([expect.objectContaining({ proposal_id: "p1", step: null })]);
	});

	it("refuses an unknown kind and lists the known kinds", async () => {
		const { pi, propose } = await withPlan();
		const result = await propose({ kind: "vectorize" });
		expect(result.isError).toBe(true);
		expect(pi.textOf(result)).toBe('Unknown kind "vectorize". Known kinds: restructure, offload, measure. Nothing was recorded.');
		expect(readPlan(toy!).proposals).toEqual([]);
		expect(proposalEvents(toy!)).toEqual([]);
	});

	it("refuses on a closed plan, with no active plan, with an empty rationale, and beyond ten open proposals", async () => {
		toy = makeToyProject();
		const { pi, run, propose } = await session(toy);
		expect(pi.textOf(await propose())).toMatch(/no active plan/);
		await run("/plan-new e1 Goal");
		expect(pi.textOf(await propose({ rationale: " " }))).toMatch(/the proposal needs a rationale/);
		for (let i = 0; i < 10; i++) await propose();
		const eleventh = await propose();
		expect(eleventh.isError).toBe(true);
		expect(pi.textOf(eleventh)).toMatch(/already has 10 open proposals/);
		await run("/plan-close keep done");
		expect(pi.textOf(await propose())).toMatch(/plan e1 is closed/);
		expect(readPlan(toy).proposals).toHaveLength(10);
		expect(proposalEvents(toy)).toHaveLength(10);
	});
});

describe("/proposals", () => {
	it("lists the open proposals", async () => {
		const { pi, run, propose } = await withPlan();
		await propose();
		pi.notifications.length = 0;
		await run("/proposals");
		expect(infos(pi)).toEqual([expect.stringMatching(/^Open proposals in plan e1:\n {2}p1 offload \[R17\]: Keep R17 on the device\n/)]);
	});
});

describe("/accept-step", () => {
	it("without start: adds a pending step whose origin names the proposal, logs accepted, and sends nothing", async () => {
		const { pi, run, propose } = await withPlan();
		await propose();
		await run("/accept-step p1");
		const plan = readPlan(toy!);
		expect(plan.steps).toEqual([{ id: "s1", kind: "offload", goal: "Keep R17 on the device", check_args: ["R17"], origin: "proposal:p1", status: "pending", attempt: 1 }]);
		expect(plan.proposals[0]!.state).toBe("accepted");
		expect(proposalEvents(toy!).map((e) => e.action)).toEqual(["proposed", "accepted"]);
		expect(pi.sentUserMessages).toEqual([]);
		expect(infos(pi).at(-1)).toBe("Accepted p1 as pending step s1 (offload): Keep R17 on the device");
		await run("/accept-step p1");
		expect(errors(pi)).toEqual([expect.stringMatching(/proposal p1 is already accepted/)]);
	});

	it("is allowed without start while a step is active", async () => {
		const { run, propose } = await withPlan();
		await run("/step measure -- Profile it");
		await propose();
		await run("/accept-step p1");
		expect(readPlan(toy!).steps.map((s) => s.status)).toEqual(["active", "pending"]);
	});

	it("with start: starts the step it created, not the first pending one, through the /next-step path", async () => {
		const { pi, run, propose } = await withPlan();
		await run("/add-step measure -- Profile first");
		await propose();
		await run("/accept-step p1 start");
		expect(errors(pi)).toEqual([]);
		const plan = readPlan(toy!);
		expect(plan.steps.map((s) => [s.id, s.status, s.origin])).toEqual([
			["s1", "pending", "user"],
			["s2", "active", "proposal:p1"],
		]);
		expect(pi.sentUserMessages).toHaveLength(1);
		expect(String(pi.sentUserMessages[0]!.content)).toMatch(/^\[harness step s2 \| kind: offload \| plan: e1\]\nEpoch goal: Goal\nStep goal: Keep R17 on the device\n/);
		// The acceptance is logged before step_start, with no step yet in its context.
		expect(toy!.readEvents().slice(-2)).toEqual([
			expect.objectContaining({ type: "proposal", proposal_id: "p1", action: "accepted", step: null }),
			expect.objectContaining({ type: "step_start", step: "s2", origin: "proposal:p1", commit: expect.any(String) }),
		]);
	});

	it("with start: a refused start changes nothing and leaves the proposal open", async () => {
		const { pi, run, propose } = await withPlan();
		await run("/step measure -- Profile it");
		await propose();
		const before = snapshot(pi, toy!);
		await run("/accept-step p1 start");
		await run("/accept-step p1 start", { idle: false });
		writeFileSync(join(toy!.dir, "tests/test_solver.txt"), "changed\n");
		await run("/abandon later");
		const afterAbandon = snapshot(pi, toy!);
		await run("/accept-step p1 start");
		expect(errors(pi)).toEqual([
			"harness: step s1 is active; finish it or /abandon it first. Proposal p1 was not accepted and is still open.",
			expect.stringMatching(/the agent is working/),
			expect.stringMatching(/^harness: protected files have uncommitted changes: tests\/test_solver.txt; .*\. Proposal p1 was not accepted and is still open\.$/),
		]);
		expect(before.events).toBe(afterAbandon.events - 1); // only the step_end from /abandon
		expect(snapshot(pi, toy!)).toEqual(afterAbandon);
		expect(readPlan(toy!).proposals[0]!.state).toBe("open");
		expect(proposalEvents(toy!).map((e) => e.action)).toEqual(["proposed"]);
	});

	it("refuses a proposal whose kind harness.json no longer defines, with or without start", async () => {
		const { pi, run, propose } = await withPlan();
		await propose();
		const config = toy!.readConfig() as { kinds: Record<string, unknown> };
		delete config.kinds.offload;
		writeFileSync(join(toy!.dir, "harness/harness.json"), JSON.stringify(config));
		const before = snapshot(pi, toy!);
		await run("/accept-step p1");
		await run("/accept-step p1 start");
		const message = 'harness: proposal p1 has kind "offload", which harness.json no longer defines (kinds: restructure, measure); add the kind back or /reject-step p1. Nothing was changed.';
		expect(errors(pi)).toEqual([message, expect.stringContaining(message)]);
		expect(snapshot(pi, toy!)).toEqual(before);
	});

	it("checks its arguments", async () => {
		const { pi, run, propose } = await withPlan();
		await propose();
		await run("/accept-step");
		await run("/accept-step p1 now");
		await run("/accept-step p1 start extra");
		await run("/accept-step p9");
		expect(errors(pi)).toEqual([
			"harness: usage: /accept-step <proposal_id> [start]",
			"harness: usage: /accept-step <proposal_id> [start]",
			"harness: usage: /accept-step <proposal_id> [start]",
			"harness: plan e1 has no proposal p9; /proposals lists the open ones",
		]);
	});

	it("asks before using a plan edited by hand, and changes nothing when refused", async () => {
		const { pi, run, propose } = await withPlan();
		await propose();
		const path = join(toy!.dir, "harness/plans/e1.json");
		writeFileSync(path, readFileSync(path, "utf8").replace("Repeated copies", "Edited by hand"));
		const before = snapshot(pi, toy!);
		await run("/accept-step p1", { ui: { confirm: [false] } });
		expect(errors(pi)).toEqual([expect.stringMatching(/the change to plan e1 was not accepted; nothing was done/)]);
		expect(snapshot(pi, toy!)).toEqual(before);
		await run("/accept-step p1", { ui: { confirm: [true] } });
		expect(readPlan(toy!)).toMatchObject({ proposals: [{ rationale: "Edited by hand", state: "accepted" }], steps: [{ origin: "proposal:p1" }] });
	});
});

describe("/reject-step", () => {
	it("marks the proposal rejected with an optional reason and logs it", async () => {
		const { pi, run, propose } = await withPlan();
		await propose();
		await propose();
		await run("/reject-step p1 the copies are cheap");
		await run("/reject-step p2");
		expect(readPlan(toy!).proposals.map((p) => [p.state, p.reason])).toEqual([
			["rejected", "the copies are cheap"],
			["rejected", undefined],
		]);
		expect(readPlan(toy!).steps).toEqual([]);
		expect(proposalEvents(toy!).map((e) => [e.proposal_id, e.action])).toEqual([
			["p1", "proposed"],
			["p2", "proposed"],
			["p1", "rejected"],
			["p2", "rejected"],
		]);
		expect(infos(pi).slice(-2)).toEqual(["Rejected p1: the copies are cheap", "Rejected p2."]);
		await run("/reject-step p1 again");
		await run("/reject-step");
		expect(errors(pi)).toEqual(["harness: proposal p1 is already rejected", "harness: usage: /reject-step <proposal_id> [reason]"]);
	});
});
