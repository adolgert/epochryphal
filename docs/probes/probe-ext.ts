// Probe extension: logs every event of interest to $PROBE_LOG.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	const log = (type: string, data: any) => {
		if (process.env.PROBE_LOG) appendFileSync(process.env.PROBE_LOG, JSON.stringify({ type, ...data }) + "\n");
	};
	for (const ev of [
		"session_start",
		"session_shutdown",
		"agent_start",
		"agent_end",
		"agent_before_settle",
		"agent_settled",
		"tool_execution_start",
		"tool_execution_end",
		"input",
		"tool_result",
	] as const) {
		pi.on(ev as any, async (e: any, ctx: any) => {
			const slim: any = {};
			for (const k of ["reason", "aborted", "text", "source", "streamingBehavior", "toolName", "toolCallId", "args", "isError", "durationMs", "previousSessionFile"])
				if (k in e) slim[k] = e[k];
			log(ev, { ...slim, hasUI: ctx.hasUI, mode: ctx.mode, idle: ctx.isIdle?.() });
		});
	}
	pi.on("message_end", async (e: any) => {
		if (e.message.role === "assistant") log("message_end", { usage: e.message.usage, stopReason: e.message.stopReason, model: e.message.model, provider: e.message.provider });
	});
	pi.on("tool_call", async (e: any) => {
		log("tool_call", { toolName: e.toolName, input: e.input });
		if ((e.toolName === "edit" || e.toolName === "write") && String(e.input.path).includes("protected")) {
			return { block: true, reason: "protected by probe" };
		}
	});
	pi.registerTool({
		name: "harness_ping",
		label: "Ping",
		description: "Ping",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "pong" }], details: {} };
		},
	});
	pi.registerTool({
		name: "finish",
		label: "Finish",
		description: "Finish, terminating",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "finished" }], details: {}, terminate: true };
		},
	});
	pi.registerCommand("probe-cmd", {
		description: "probe",
		handler: async (args, ctx) => {
			log("command", { args, hasUI: ctx.hasUI, mode: ctx.mode });
			if (args === "send") pi.sendUserMessage("from command");
			if (args === "sendwait") { pi.sendUserMessage("from command"); await ctx.waitForIdle(); log("after_wait", {}); }
		},
	});
	pi.registerTool({
		name: "slow",
		label: "Slow",
		description: "Sleeps 300 ms",
		parameters: Type.Object({}),
		async execute(_id, _p, signal) {
			await new Promise((r) => setTimeout(r, 300));
			return { content: [{ type: "text", text: signal?.aborted ? "slow aborted" : "slow done" }], details: {} };
		},
	});
	let continued = false;
	pi.on("agent_settled", async (e: any) => {
		if (process.env.PROBE_CONTINUE === "settled" && !continued && !e.aborted) {
			continued = true;
			pi.sendUserMessage("continuation via settled");
		}
	});
	pi.on("agent_before_settle", async (e: any) => {
		if (process.env.PROBE_CONTINUE === "before_settle" && !continued) {
			continued = true;
			return { entries: [...e.entries, { type: "custom_message", customType: "probe", content: "continuation via before_settle", display: true }], continue: true };
		}
	});
	pi.registerCommand("probe-dialog", {
		description: "probe dialog",
		handler: async (_args, ctx) => {
			const sel = await ctx.ui.select("Pick", ["a", "b"]);
			const ok = await ctx.ui.confirm("T", "M");
			const inp = await ctx.ui.input("I");
			log("dialog", { sel, ok, inp, hasUI: ctx.hasUI });
		},
	});
}
