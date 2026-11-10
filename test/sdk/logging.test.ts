// Level 2: event logging with a real pi session. These tests are the drift tests for the pi
// events that logging subscribes to; run them first after a pi upgrade (npm run test:drift).
import { afterEach, describe, expect, it } from "vitest";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";
import { makeToyProject } from "../rig/toy-project.ts";

let s: SdkSession | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
});

describe("event log in a real session", () => {
	it("[drift] tool_execution_start/end and message_end: two tool calls and three model calls are logged", async () => {
		s = await runSdkSession({
			script: [{ tool: "harness_ping", args: {} }, { tool: "harness_ping", args: { extra: "x" } }, { text: "done" }],
		});
		await s.prompt("hello");
		const events = s.project.readEvents();
		const tools = events.filter((e) => e.type === "tool_call");
		expect(tools.map((e) => [e.tool, e.is_error])).toEqual([
			["harness_ping", false],
			["harness_ping", false],
		]);
		expect(tools.map((e) => e.args_summary)).toEqual(["{}", '{"extra":"x"}']);
		expect(tools.every((e) => typeof e.duration_ms === "number")).toBe(true);
		const models = events.filter((e) => e.type === "model_call");
		expect(models).toHaveLength(3);
		for (const m of models) {
			expect(m).toMatchObject({ model: "scripted/scripted-1", input: 100, output: 10, total_tokens: 110, cost_usd: 0.0015 });
		}
		expect(models.map((m) => m.stop_reason)).toEqual(["toolUse", "toolUse", "stop"]);
	});

	it("[drift] session_start and session_shutdown: the log begins and ends with them", async () => {
		const project = makeToyProject();
		s = await runSdkSession({ script: [{ text: "done" }], project });
		await s.prompt("hello");
		const sessionId = s.session.sessionId;
		await s.dispose();
		s = undefined;
		const events = project.readEvents();
		expect(events[0]).toMatchObject({ type: "session_start", reason: "startup", session: sessionId, mode: "supervised" });
		expect(events.at(-1)).toMatchObject({ type: "session_end", reason: "quit", session: sessionId });
		project.cleanup();
	});

	it("logs a blocked or failing tool call with is_error true", async () => {
		s = await runSdkSession({ script: [{ tool: "no_such_tool", args: {} }, { text: "done" }] });
		await s.prompt("hello");
		const tools = s.project.readEvents().filter((e) => e.type === "tool_call");
		expect(tools).toEqual([expect.objectContaining({ tool: "no_such_tool", is_error: true, duration_ms: null })]);
	});
});
