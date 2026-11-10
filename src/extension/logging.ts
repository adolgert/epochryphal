// Binds pi events to the event log (plan Section 7.5).
import type { CompactionEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { Clock } from "../core/clock.ts";
import { EventLog, summarize } from "../core/log.ts";
import { findProjectRoot } from "../core/project.ts";
import { followLog, type HarnessState, report } from "./state.ts";

export function registerLogging(pi: ExtensionAPI, state: HarnessState, clock?: Clock): void {
	/** Arguments of tool calls that have started but not ended, by tool call id. */
	const pending = new Map<string, unknown>();

	pi.on("session_start", async (event, ctx) => {
		state.ctx = ctx;
		state.session = ctx.sessionManager.getSessionId();
		state.root = findProjectRoot(ctx.cwd, state.harnessDir);
		state.log = null;
		if (state.root === null) {
			report(state, `no ${join(state.harnessDir, "harness.json")} found at or above ${ctx.cwd}; harness inactive`, "warning");
			return;
		}
		const path = join(state.root, state.harnessDir, "log", "events.jsonl");
		state.log = new EventLog({
			path,
			clock,
			context: () => ({ session: state.session, mode: state.mode, step: state.step }),
			onFirstError: (e) => report(state, `cannot write the event log ${path}: ${e.message}. Work continues without it.`),
			onWrite: (record) => followLog(state, record),
		});
		state.log.write("session_start", { reason: event.reason });
	});

	pi.on("session_shutdown", async (event, ctx) => {
		state.ctx = ctx;
		state.log?.write("session_end", { reason: event.reason });
	});

	pi.on("tool_execution_start", async (event) => {
		pending.set(event.toolCallId, event.args);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		state.ctx = ctx;
		const args = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		state.log?.write("tool_call", {
			tool: event.toolName,
			args_summary: summarize(args ?? {}),
			// Absent when the tool did not run, for example when a guard blocked it.
			duration_ms: event.durationMs ?? null,
			is_error: event.isError,
			parent: event.parentToolCallId ?? null,
		});
	});

	// Every started call ends before the run settles, even when aborted (docs/pi-facts.md, Step 6).
	// Clearing here keeps a call that somehow never ended from staying in memory.
	pi.on("agent_settled", async () => {
		pending.clear();
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		state.ctx = ctx;
		const u = message.usage;
		state.log?.write("model_call", {
			model: `${message.provider}/${message.model}`,
			input: u.input,
			output: u.output,
			cache_read: u.cacheRead,
			cache_write: u.cacheWrite,
			total_tokens: u.totalTokens,
			cost_usd: u.cost.total,
			stop_reason: message.stopReason,
		});
	});

	// Compaction and branch summaries call the model outside the agent loop, with no message_end
	// (docs/pi-facts.md, Step 9). Their usage is logged as model calls, so budgets count it; the
	// stop rules act at the next model call (budget.ts). The model is the session's; a compaction
	// model set in pi's settings is not seen here.
	const logHidden = (usage: CompactionEntry["usage"], kind: string, ctx: ExtensionContext) => {
		if (!usage) return;
		state.ctx = ctx;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
		state.log?.write("model_call", {
			model,
			input: usage.input,
			output: usage.output,
			cache_read: usage.cacheRead,
			cache_write: usage.cacheWrite,
			total_tokens: usage.totalTokens,
			cost_usd: usage.cost.total,
			stop_reason: kind,
		});
	};
	pi.on("session_compact", async (event, ctx) => logHidden(event.compactionEntry.usage, "compaction", ctx));
	pi.on("session_tree", async (event, ctx) => logHidden(event.summaryEntry?.usage, "branch_summary", ctx));
}
