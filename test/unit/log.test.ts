// Level 1: the event log writer (plan Section 5.3).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, type LogContext, summarize } from "../../src/core/log.ts";
import { FakeClock } from "../rig/clock.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "harness-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (path: string) =>
	readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));

describe("EventLog", () => {
	it("writes one JSON line per event with the common fields first", () => {
		const path = join(dir, "log/events.jsonl");
		const context: LogContext = { session: "sess-1", mode: "run_plan", step: { plan: "e1", step: "s2", attempt: 3 } };
		const log = new EventLog({ path, context: () => context, clock: new FakeClock("2026-11-10T14:05:09.120Z") });
		log.write("session_start", { reason: "startup" });
		log.write("tool_call", { tool: "build", args_summary: "{}", duration_ms: 5, is_error: false });
		const records = read(path);
		expect(records).toHaveLength(2);
		expect(records[0]).toEqual({
			ts: "2026-11-10T14:05:09.120Z",
			session: "sess-1",
			mode: "run_plan",
			plan: "e1",
			step: "s2",
			attempt: 3,
			type: "session_start",
			reason: "startup",
		});
		expect(Object.keys(records[1]).slice(0, 7)).toEqual(["ts", "session", "mode", "plan", "step", "attempt", "type"]);
	});

	it("writes null plan, step, and attempt when no step is active", () => {
		const path = join(dir, "events.jsonl");
		const log = new EventLog({ path, context: () => ({ session: null, mode: "supervised", step: null }) });
		log.write("session_start", { reason: "startup" });
		expect(read(path)[0]).toMatchObject({ session: null, plan: null, step: null, attempt: null });
	});

	it("reads the context at each write", () => {
		const path = join(dir, "events.jsonl");
		let context: LogContext = { session: "a", mode: "supervised", step: null };
		const log = new EventLog({ path, context: () => context });
		log.write("session_start", { reason: "startup" });
		context = { session: "a", mode: "supervised", step: { plan: "e1", step: "s1", attempt: 1 } };
		log.write("step_start", { kind: "measure", goal: "g", origin: "user", commit: "abc123" });
		expect(read(path).map((r) => r.step)).toEqual([null, "s1"]);
	});

	it("does not throw when a write fails, and reports only the first failure", () => {
		writeFileSync(join(dir, "log"), "a file where the log directory should be");
		const errors: Error[] = [];
		const log = new EventLog({
			path: join(dir, "log/events.jsonl"),
			context: () => ({ session: null, mode: "supervised", step: null }),
			onFirstError: (e) => errors.push(e),
		});
		expect(() => {
			log.write("session_start", { reason: "startup" });
			log.write("session_end", { reason: "quit" });
		}).not.toThrow();
		expect(errors).toHaveLength(1);
	});

	it("does not throw when the error reporter itself throws", () => {
		mkdirSync(join(dir, "events.jsonl"));
		const log = new EventLog({
			path: join(dir, "events.jsonl"),
			context: () => ({ session: null, mode: "supervised", step: null }),
			onFirstError: () => {
				throw new Error("reporter broke");
			},
		});
		expect(() => log.write("session_start", { reason: "startup" })).not.toThrow();
	});
});

describe("summarize", () => {
	it("returns short JSON unchanged and cuts long JSON to 200 characters", () => {
		expect(summarize({ variant: "gpu" })).toBe('{"variant":"gpu"}');
		expect(summarize({ text: "x".repeat(500) })).toHaveLength(200);
	});

	it("does not throw on values JSON cannot represent", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => summarize(cyclic)).not.toThrow();
		expect(summarize(undefined)).toBe("undefined");
	});
});
