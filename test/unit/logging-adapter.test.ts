// Level 1 (stub): the extension turns pi events into event-log records.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { FakeClock } from "../rig/clock.ts";
import { FakePi } from "../rig/fake-pi.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

async function started(t: ToyProject, cwd = t.dir): Promise<FakePi> {
	const pi = new FakePi().load(createHarnessExtension({ clock: new FakeClock() }));
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, { cwd, sessionId: "s-123" });
	return pi;
}

describe("logging adapter", () => {
	it("writes session_start with the session id and reason", async () => {
		toy = makeToyProject();
		await started(toy);
		expect(toy.readEvents()).toEqual([
			{ ts: "2026-11-10T14:00:00.000Z", session: "s-123", mode: "supervised", plan: null, step: null, attempt: null, type: "session_start", reason: "startup" },
		]);
	});

	it("logs at the project root when pi starts in a subdirectory", async () => {
		toy = makeToyProject();
		await started(toy, join(toy.dir, "src"));
		expect(toy.readEvents().map((e) => e.type)).toEqual(["session_start"]);
		expect(existsSync(join(toy.dir, "src/harness"))).toBe(false);
	});

	it("is inactive where no harness.json exists: writes nothing and says so once", async () => {
		toy = makeToyProject();
		const elsewhere = join(toy.workDir, "elsewhere");
		mkdirSync(elsewhere);
		const pi = await started(toy, elsewhere);
		await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
		await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: {}, isError: false });
		await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(existsSync(join(elsewhere, "harness"))).toBe(false);
		expect(pi.notifications).toEqual([{ message: expect.stringMatching(/no harness\/harness\.json found .*harness inactive/), type: "warning" }]);
	});

	it("joins tool_execution_start and tool_execution_end into one tool_call record", async () => {
		toy = makeToyProject();
		const pi = await started(toy);
		const ctx = { cwd: toy.dir };
		await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "a.txt", content: "y".repeat(500) } }, ctx);
		await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "write", result: {}, isError: false, durationMs: 12 }, ctx);
		const calls = toy.readEvents().filter((e) => e.type === "tool_call");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ tool: "write", duration_ms: 12, is_error: false });
		expect(calls[0]!.args_summary).toHaveLength(200);
		expect(String(calls[0]!.args_summary).startsWith('{"path":"a.txt","content":"yyy')).toBe(true);
	});

	it("records the parent of a call that another tool made, and null for a call the model made", async () => {
		toy = makeToyProject();
		const pi = await started(toy);
		await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "code", args: {} });
		await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1/1", toolName: "read", args: {}, parentToolCallId: "c1" });
		await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1/1", toolName: "read", result: {}, isError: false, durationMs: 1, parentToolCallId: "c1" });
		await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "code", result: {}, isError: false, durationMs: 2 });
		expect(toy.readEvents().filter((e) => e.type === "tool_call").map((e) => [e.tool, e.parent])).toEqual([
			["read", "c1"],
			["code", null],
		]);
	});

	it("forgets started calls when the run settles", async () => {
		toy = makeToyProject();
		const pi = await started(toy);
		await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a" } });
		await pi.fire("agent_settled", { type: "agent_settled", aborted: true });
		await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: {}, isError: true });
		expect(toy.readEvents().find((e) => e.type === "tool_call")).toMatchObject({ args_summary: "{}" });
	});

	it("records a call that did not run (no durationMs) with duration_ms null", async () => {
		toy = makeToyProject();
		const pi = await started(toy);
		await pi.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: {} });
		await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c2", toolName: "edit", result: {}, isError: true });
		expect(toy.readEvents().find((e) => e.type === "tool_call")).toMatchObject({ duration_ms: null, is_error: true });
	});

	it("writes a model_call for each assistant message and ignores other messages", async () => {
		toy = makeToyProject();
		const pi = await started(toy);
		const usage = { input: 100, output: 10, cacheRead: 5, cacheWrite: 7, totalTokens: 122, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 } };
		await pi.fire("message_end", { type: "message_end", message: { role: "user", content: "hi", timestamp: 0 } });
		await pi.fire("message_end", {
			type: "message_end",
			message: { role: "assistant", content: [], provider: "anthropic", model: "m-1", usage, stopReason: "toolUse", api: "x", timestamp: 0 },
		});
		const calls = toy.readEvents().filter((e) => e.type === "model_call");
		expect(calls).toEqual([
			expect.objectContaining({
				model: "anthropic/m-1",
				input: 100,
				output: 10,
				cache_read: 5,
				cache_write: 7,
				total_tokens: 122,
				cost_usd: 0.0042,
				stop_reason: "toolUse",
			}),
		]);
	});

	it("writes session_end on session_shutdown", async () => {
		toy = makeToyProject();
		const pi = await started(toy);
		await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(toy.readEvents().at(-1)).toMatchObject({ type: "session_end", reason: "quit" });
	});

	it("tells the person once when the log cannot be written, and keeps working", async () => {
		toy = makeToyProject();
		writeFileSync(join(toy.dir, "harness/log"), "not a directory");
		const pi = await started(toy);
		await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(pi.notifications).toHaveLength(1);
		expect(pi.notifications[0]).toMatchObject({ type: "error" });
		expect(pi.notifications[0]!.message).toMatch(/cannot write the event log/);
		expect(readFileSync(join(toy.dir, "harness/log"), "utf8")).toBe("not a directory");
	});
});
