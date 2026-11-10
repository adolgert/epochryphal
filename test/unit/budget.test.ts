// Level 1: the budget tracker, its rebuild from the event log, the stop rules, and the working-tree
// fingerprint behind the stall rule.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTracker, rebuildTracker, track, type Tracker, usageOf } from "../../src/core/budget.ts";
import type { Budget, HarnessConfig } from "../../src/core/config.ts";
import { EventLog, readEvents } from "../../src/core/log.ts";
import { currentCommit, treeFingerprint } from "../../src/core/protect.ts";
import { trippedRules } from "../../src/core/rules.ts";
import { stepBudget } from "../../src/core/status.ts";
import { stepRecord } from "../../src/core/steps.ts";
import { FakeClock } from "../rig/clock.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

const ref = { plan: "e1", step: "s1", attempt: 1 };
const START = Date.parse("2026-11-10T14:00:00Z");
const budget: Budget = { tokens: 1000, cost_usd: 1, agent_minutes: 10, check_attempts: 3 };

/** A tracker for `ref` that started at START, with fields set. */
function tracker(fields: Partial<Tracker> = {}): Tracker {
	return { ...newTracker(ref), start_ms: START, ...fields };
}
const rules = (t: Tracker, nowMs = START) => trippedRules(t, budget, nowMs).map((r) => r.rule);
const failed = (...checks: [string | null, string | null][]) => checks.map(([signature, tree]) => ({ signature, tree }));

let dirs: string[] = [];
let toy: ToyProject | undefined;
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
	toy?.cleanup();
	toy = undefined;
});

describe("stop rules", () => {
	it("budget_tokens trips one token over the budget, not at it", () => {
		expect(rules(tracker({ tokens: 1000 }))).toEqual([]);
		expect(trippedRules(tracker({ tokens: 1001 }), budget, START)).toEqual([
			{ rule: "budget_tokens", value: 1001, limit: 1000, why: "1001 tokens used, budget 1000" },
		]);
	});

	it("budget_cost trips over the budget, not at it", () => {
		expect(rules(tracker({ cost_usd: 1 }))).toEqual([]);
		expect(rules(tracker({ cost_usd: 1.0001 }))).toEqual(["budget_cost"]);
	});

	it("budget_minutes trips over the budget, not at it, and leaves out is_wait time", () => {
		const t = tracker();
		expect(rules(t, START + 10 * 60_000)).toEqual([]);
		expect(rules(t, START + 10 * 60_000 + 1)).toEqual(["budget_minutes"]);
		expect(rules(tracker({ wait_ms: 60_000 }), START + 11 * 60_000)).toEqual([]);
		expect(rules(tracker({ wait_ms: 60_000 }), START + 11 * 60_000 + 1)).toEqual(["budget_minutes"]);
	});

	it("max_check_attempts trips when failed checks reach the budget, not one before", () => {
		expect(rules(tracker({ failed_checks: failed(["a", null], ["b", null]) }))).toEqual([]);
		expect(trippedRules(tracker({ failed_checks: failed(["a", null], ["b", null], ["c", null]) }), budget, START)).toEqual([
			{ rule: "max_check_attempts", value: 3, limit: 3, why: "3 failed checks, budget 3" },
		]);
	});

	it("stall trips on two equal signatures, not on two different ones or two empty ones", () => {
		expect(rules(tracker({ failed_checks: failed(["T1", null], ["T1", null]) }))).toEqual(["stall"]);
		expect(rules(tracker({ failed_checks: failed(["T1", null], ["T2", null]) }))).toEqual([]);
		expect(rules(tracker({ failed_checks: failed(["", null], ["", null]) }))).toEqual([]);
		expect(rules(tracker({ failed_checks: failed([null, null], [null, null]) }))).toEqual([]);
	});

	it("stall trips on an unchanged working tree, whatever the signatures", () => {
		expect(trippedRules(tracker({ failed_checks: failed(["T1", "tree-a"], ["T2", "tree-a"]) }), budget, START)).toEqual([
			{ rule: "stall", value: null, limit: null, why: "the working tree did not change between the last two failed checks" },
		]);
		expect(rules(tracker({ failed_checks: failed([null, "tree-a"], [null, "tree-b"]) }))).toEqual([]);
	});

	it("stall looks only at the last two failed checks", () => {
		expect(rules(tracker({ failed_checks: failed(["T1", null], ["T1", null], ["T2", null]) }))).toEqual(["max_check_attempts"]);
		expect(rules(tracker({ failed_checks: failed(["T1", null]) }))).toEqual([]);
	});

	it("several rules can hold at once, in a fixed order", () => {
		const t = tracker({ tokens: 2000, cost_usd: 2, failed_checks: failed(["T", "x"], ["T", "x"], ["T", "x"]) });
		expect(rules(t, START + 11 * 60_000)).toEqual(["budget_tokens", "budget_cost", "budget_minutes", "max_check_attempts", "stall"]);
	});

	it("a step-level budget overrides single fields of the kind's budget", () => {
		const config = { kinds: { offload: { budget } } } as unknown as HarnessConfig;
		expect(stepBudget(config, { kind: "offload", budget: { tokens: 50 } })).toEqual({ ...budget, tokens: 50 });
		expect(stepBudget(config, { kind: "offload" })).toEqual(budget);
		expect(rules(tracker({ tokens: 51 })).length).toBe(0);
		expect(trippedRules(tracker({ tokens: 51 }), stepBudget(config, { kind: "offload", budget: { tokens: 50 } })!, START).map((r) => r.rule)).toEqual(["budget_tokens"]);
	});
});

describe("budget tracker", () => {
	/** Write one attempt's events through a real EventLog, feeding a live tracker as they are written. */
	function produce() {
		const dir = mkdtempSync(join(tmpdir(), "budget-"));
		dirs.push(dir);
		const clock = new FakeClock(START);
		let step: typeof ref | null = null;
		let live: Tracker | null = null;
		const log = new EventLog({
			path: join(dir, "events.jsonl"),
			clock,
			context: () => ({ session: "s", mode: "supervised", step }),
			onWrite: (r) => {
				if (r.type === "step_start" && step) live = newTracker(step);
				if (live) track(live, r);
			},
		});
		const model = (tokens: number) => ({ model: "m", input: tokens - 10, output: 10, cache_read: 0, cache_write: 0, total_tokens: tokens, cost_usd: tokens / 100_000, stop_reason: "toolUse" });
		const script = (is_wait: boolean, ok: boolean | null, ms: number) => ({ name: "x", is_wait, outcome: ok === null ? ("script_error" as const) : ("result" as const), ok, signature: null, duration_ms: ms, timed_out: false, output_path: "o" });
		const check = (outcome: "result" | "script_error", ok: boolean | null, signature: string | null, tree: string | null) => ({ outcome, ok, signature, summary: "s", duration_ms: 5, by: "submit" as const, tree });
		log.write("session_start", { reason: "startup" });
		// Another attempt's events must not count.
		step = { ...ref, attempt: 0 };
		log.write("step_start", { kind: "measure", goal: "g", origin: "user", commit: "c" });
		log.write("model_call", model(5000));
		log.write("step_end", { outcome: "abandoned", detail: "x" });
		step = { ...ref };
		clock.advanceMinutes(1);
		log.write("step_start", { kind: "measure", goal: "g", origin: "user", commit: "c" });
		clock.advanceMinutes(1);
		log.write("model_call", model(110));
		log.write("script", script(false, false, 2000));
		log.write("script", script(true, true, 3 * 60_000));
		log.write("script", script(false, null, 10));
		log.write("model_call", model(220));
		log.write("check", check("result", false, "protected_changed", "tree-1"));
		log.write("check", check("script_error", null, null, null));
		log.write("rule_tripped", { rule: "budget_tokens", action: "warn", value: 330, limit: 300 });
		clock.advanceMinutes(5);
		log.write("check", check("result", false, "T1", "tree-2"));
		log.write("session_end", { reason: "quit" });
		clock.advanceMinutes(4);
		log.write("model_call", model(110));
		log.write("check", check("result", true, null, null));
		log.write("step_end", { outcome: "stopped", detail: "stop rule stall: x" });
		return { events: readEvents(log.path), live: live as Tracker | null, clock };
	}

	it("the tracker rebuilt from an event log equals the tracker that produced the log", () => {
		const { events, live } = produce();
		expect(live).not.toBeNull();
		expect(rebuildTracker(events, ref)).toEqual(live);
		expect(live).toEqual({
			ref,
			start_ms: START + 60_000,
			tokens: 440,
			cost_usd: expect.closeTo(0.0044, 10),
			model_calls: 3,
			wait_ms: 3 * 60_000,
			script_failures: 2,
			check_attempts: 3,
			failed_checks: failed(["protected_changed", "tree-1"], ["T1", "tree-2"]),
			tripped: [{ rule: "budget_tokens", action: "warn" }],
		});
	});

	it("the step record agrees with the tracker: tokens, cost, minutes, check attempts", () => {
		const { events, live, clock } = produce();
		const record = stepRecord(events, ref)!;
		const usage = usageOf(live!, clock.now());
		expect(record).toMatchObject({ tokens: usage.tokens, check_attempts: usage.check_attempts, model_calls: 3, script_failures: 2, wait_minutes: 3 });
		expect(record.cost_usd).toBeCloseTo(usage.cost_usd, 6);
		// 10 minutes from step_start to step_end, minus 3 minutes waiting.
		expect(record.agent_minutes).toBe(7);
		expect(usage.agent_minutes).toBe(7);
	});

	it("the step record names the first rule that stopped the step, and only when the outcome is stopped", () => {
		const { events } = produce();
		const stop = { ...events.find((e) => e.type === "rule_tripped")!, rule: "stall", action: "stop" };
		const end = events.findIndex((e) => e.type === "step_end" && e.attempt === 1);
		const withStop: Record<string, unknown>[] = [...events.slice(0, end), stop, ...events.slice(end)];
		expect(stepRecord(withStop, ref)).toMatchObject({ outcome: "stopped", stop_rule: "stall", reason: "stop rule stall: x" });
		// A warn is not a stop.
		expect(stepRecord(events, ref)).toMatchObject({ outcome: "stopped", stop_rule: null });
		const passed = withStop.map((e) => (e.type === "step_end" ? { ...e, outcome: "passed" } : e));
		expect(stepRecord(passed, ref)).toMatchObject({ stop_rule: null });
	});

	it("agent minutes include time when no session was open", () => {
		const { live } = produce();
		// The session ended at 7 minutes in and the attempt continued in a later one: wall-clock still counts.
		expect(usageOf(live!, START + 60_000 + 60 * 60_000).agent_minutes).toBe(57);
	});
});

describe("working-tree fingerprint", () => {
	const fp = (t: ToyProject, base: string) => treeFingerprint(t.dir, base, "harness");

	it("is stable, and changes with a tracked edit, an untracked file, a deletion, and a mode change", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		const first = fp(toy, base);
		expect(fp(toy, base)).toBe(first);
		const seen = new Set([first]);
		const changes: (() => void)[] = [
			() => writeFileSync(join(toy!.dir, "src/solver.txt"), "changed\n"),
			() => writeFileSync(join(toy!.dir, "src/solver.txt"), "changed again\n"),
			() => writeFileSync(join(toy!.dir, "src/new.txt"), "new\n"),
			() => writeFileSync(join(toy!.dir, "src/new.txt"), "new, edited\n"),
			() => unlinkSync(join(toy!.dir, "src/driver.txt")),
			() => execFileSync("chmod", ["+x", join(toy!.dir, "src/solver.txt")]),
			() => symlinkSync("solver.txt", join(toy!.dir, "src/link")),
		];
		for (const change of changes) {
			change();
			const next = fp(toy, base);
			expect(seen.has(next)).toBe(false);
			seen.add(next);
		}
	});

	it("returns to the same value when a file is restored to its committed content", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		const first = fp(toy, base);
		writeFileSync(join(toy.dir, "src/solver.txt"), "changed\n");
		writeFileSync(join(toy.dir, "src/solver.txt"), "solve the tridiagonal system\n");
		expect(fp(toy, base)).toBe(first);
	});

	it("ignores the harness's plans and log, and files git ignores", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		const first = fp(toy, base);
		mkdirSync(join(toy.dir, "harness/plans"), { recursive: true });
		mkdirSync(join(toy.dir, "harness/log/outputs"), { recursive: true });
		writeFileSync(join(toy.dir, "harness/plans/e1.json"), "{}\n");
		writeFileSync(join(toy.dir, "harness/plans/ACTIVE"), "e1\n");
		writeFileSync(join(toy.dir, "harness/log/events.jsonl"), "{}\n");
		writeFileSync(join(toy.dir, ".gitignore"), "harness/log/\n*.o\n");
		const withIgnore = fp(toy, base); // .gitignore itself is tracked, so this changes it.
		expect(withIgnore).not.toBe(first);
		writeFileSync(join(toy.dir, "src/solver.o"), "object\n");
		expect(fp(toy, base)).toBe(withIgnore);
	});

	it("is the same after the agent commits its change, because it compares with the step's base commit", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		writeFileSync(join(toy.dir, "src/solver.txt"), "changed\n");
		const before = fp(toy, base);
		toy.git("-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-q", "-am", "agent commit");
		expect(fp(toy, base)).toBe(before);
	});

	it("throws outside a git repository, so the caller can store null", () => {
		const dir = mkdtempSync(join(tmpdir(), "nogit-"));
		dirs.push(dir);
		expect(() => treeFingerprint(dir, "HEAD", "harness")).toThrow(/git/);
	});
});
