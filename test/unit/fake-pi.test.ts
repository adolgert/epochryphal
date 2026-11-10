// Level 1: the hand-written stub of pi's extension API.
import { describe, expect, it } from "vitest";
import extension from "../../src/extension/index.ts";
import { FakePi } from "../rig/fake-pi.ts";

describe("FakePi", () => {
	it("records the tools an extension registers", () => {
		const pi = new FakePi();
		pi.load(extension);
		expect(pi.toolNames()).toContain("harness_ping");
	});

	it("calls a registered tool's execute and returns its result", async () => {
		const pi = new FakePi();
		pi.load(extension);
		const result = await pi.callTool("harness_ping", {});
		expect(result.isError ?? false).toBe(false);
		expect(pi.textOf(result)).toBe("pong");
	});

	it("refuses to call a tool that was not registered", async () => {
		const pi = new FakePi();
		pi.load(extension);
		await expect(pi.callTool("no_such_tool", {})).rejects.toThrow(/no_such_tool/);
	});

	it("fires an event to every handler registered for it, in order", async () => {
		const pi = new FakePi();
		const seen: string[] = [];
		pi.on("session_start", async () => {
			seen.push("first");
		});
		pi.on("session_start", async () => {
			seen.push("second");
		});
		await pi.fire("session_start", { type: "session_start", reason: "startup" });
		expect(seen).toEqual(["first", "second"]);
	});

	it("runs a command handler with a context whose dialog answers are scripted", async () => {
		const pi = new FakePi();
		let answer: string | undefined;
		pi.registerCommand("ask", {
			description: "ask something",
			handler: async (_args, ctx) => {
				answer = await ctx.ui.select("Pick", ["continue", "stop"]);
			},
		});
		await pi.runCommand("ask", "", { ui: { select: ["stop"] } });
		expect(answer).toBe("stop");
	});

	it("records user messages sent by the extension", async () => {
		const pi = new FakePi();
		pi.registerCommand("go", {
			description: "go",
			handler: async () => {
				pi.sendUserMessage("hello agent");
			},
		});
		await pi.runCommand("go", "");
		expect(pi.sentUserMessages).toEqual([{ content: "hello agent", options: undefined }]);
	});
});
