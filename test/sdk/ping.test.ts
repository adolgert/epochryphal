// Level 2: a real pi session in-process, driven by the scripted model.
import { afterEach, describe, expect, it } from "vitest";
import { runSdkSession, type SdkSession } from "../rig/sdk-session.ts";

let s: SdkSession | undefined;
afterEach(async () => {
	await s?.dispose();
	s = undefined;
});

describe("SDK session with the scripted model", () => {
	it("calls harness_ping, then ends with the scripted final text", async () => {
		s = await runSdkSession({
			script: [{ tool: "harness_ping", args: {} }, { text: "The step is complete." }],
		});
		await s.prompt("hello");
		expect(s.lastAssistantText()).toBe("The step is complete.");
		const pingResults = s.toolResults().filter((r) => r.toolName === "harness_ping");
		expect(pingResults.map((r) => r.text)).toEqual(["pong"]);
	});

	it("records each request; the tool list in the first request includes harness_ping", async () => {
		s = await runSdkSession({
			script: [{ tool: "harness_ping", args: {} }, { text: "done" }],
		});
		await s.prompt("hello");
		const requests = s.requests();
		expect(requests).toHaveLength(2);
		expect(requests[0]!.tools).toContain("harness_ping");
		expect(requests[0]!.system).toContain("coding assistant");
	});

	it("uses the scripted model and never a real one", async () => {
		s = await runSdkSession({ script: [{ text: "done" }] });
		expect(s.session.model?.provider).toBe("scripted");
	});

	it("reports the scripted usage numbers on every assistant message", async () => {
		s = await runSdkSession({
			script: [{ tool: "harness_ping", args: {} }, { text: "done" }],
		});
		await s.prompt("hello");
		const usages = s.assistantMessages().map((m) => [m.usage.input, m.usage.output, m.usage.totalTokens]);
		expect(usages).toEqual([
			[100, 10, 110],
			[100, 10, 110],
		]);
	});

	it("fails the test when the script runs out", async () => {
		s = await runSdkSession({ script: [{ tool: "harness_ping", args: {} }] });
		await expect(s.prompt("hello")).rejects.toThrow(/SCRIPT_EXHAUSTED/);
	});
});
