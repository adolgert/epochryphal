// Procedure tools (plan Section 7.3): one tool per entry of `procedures` in harness.json, the
// `requires` rule, and the `script` event that wait-time accounting reads (Section 7.7).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { type TSchema, Type } from "typebox";
import type { Clock } from "../core/clock.ts";
import { type HarnessConfig, loadConfig, type ParamSpec, type ProcedureConfig } from "../core/config.ts";
import { readEvents } from "../core/log.ts";
import { EDIT_TOOLS, type RequiresTracker, trackerFromEvents } from "../core/requires.ts";
import { runScript } from "../core/script.ts";
import { attemptEvents } from "../core/steps.ts";
import { type HarnessState, report } from "./state.ts";

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: undefined, isError });

/**
 * The parameter schema of a procedure tool. Every configured parameter is required, so a script
 * always receives each one. An enumeration is `{ type: "string", enum }`, the form pi-ai's
 * StringEnum makes, which every provider accepts.
 */
export function procedureSchema(params: Record<string, ParamSpec>) {
	const properties: Record<string, TSchema> = {};
	for (const [key, spec] of Object.entries(params)) {
		const options = spec.description === undefined ? {} : { description: spec.description };
		if (spec.type === "string") properties[key] = Type.String(spec.enum ? { ...options, enum: spec.enum } : options);
		else if (spec.type === "number") properties[key] = Type.Number(options);
		else if (spec.type === "integer") properties[key] = Type.Integer(options);
		else properties[key] = Type.Boolean(options);
	}
	return Type.Object(properties);
}

export interface ProceduresApi {
	/**
	 * The procedure whose call `toolCallId` returned a failed result (ok false, not a script error or
	 * a refusal), or null. Each call is reported once: lessons.ts asks at tool_result.
	 */
	takeFailed(toolCallId: string): ProcedureConfig | null;
}

export function registerProcedures(pi: ExtensionAPI, state: HarnessState, clock?: Clock): ProceduresApi {
	/** Every tool name this extension has registered as a procedure, in this or an earlier project. */
	const registered = new Set<string>();
	/** Procedures of the current project that are registered as tools. */
	let procs = new Map<string, ProcedureConfig>();
	let config: HarnessConfig | null = null;
	/** Calls that returned a failed result and whose tool_result has not fired yet. */
	const failed = new Map<string, ProcedureConfig>();

	// The requires tracker of the current step attempt ("" when no step is active). When the
	// attempt changes, including after a restart, it is rebuilt from that attempt's events.
	let tracked: { key: string; tracker: RequiresTracker } | null = null;
	const tracker = (): RequiresTracker => {
		const step = state.step;
		const key = step ? `${step.plan}\n${step.step}\n${step.attempt}` : "";
		if (tracked?.key !== key) {
			let events: Record<string, unknown>[] = [];
			try {
				if (step && state.log) events = attemptEvents(readEvents(state.log.path), step);
			} catch {
				// An unreadable log: start empty. The scripts remain the final authority on staleness.
			}
			tracked = { key, tracker: trackerFromEvents(events) };
		}
		return tracked.tracker;
	};

	const register = ({ name, description, params: paramSpecs }: ProcedureConfig) => {
		pi.registerTool({
			name,
			label: name,
			description,
			parameters: procedureSchema(paramSpecs),
			// Procedures share the requires state, so calls in one batch run in order.
			executionMode: "sequential",
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				state.ctx = ctx;
				// Looked up at call time: a later session_start may have changed or removed it.
				const proc = procs.get(name);
				if (!proc || !config || state.root === null) {
					return reply(`${name} is not a procedure of the current project, so it was not run. Do not call it again.`, true);
				}
				const missing = tracker().missing(proc.requires);
				if (missing.length > 0) {
					const scope = state.step ? `step ${state.step.step}` : "this session";
					return reply(
						`${name} was not run: it requires ${missing.join(", ")} to succeed first in ${scope}, with no edit or write of a file since. Call ${missing.join(", then ")}, then call ${name} again.`,
						true,
					);
				}
				const given = params as Record<string, unknown>;
				const input = Object.fromEntries(Object.keys(proc.params).filter((k) => k in given).map((k) => [k, given[k]]));
				const step = state.step;
				const outcome = await runScript(
					proc.command,
					{ params: input, plan: step?.plan ?? null, step: step?.step ?? null, attempt: step?.attempt ?? null, kind: step?.kind ?? null },
					{
						cwd: state.root,
						name,
						timeoutMs: proc.timeout_s * 1000,
						maxSummaryChars: config.max_summary_chars,
						outputDir: join(state.root, state.harnessDir, "log", "outputs"),
						signal,
						clock,
					},
				);
				const result = outcome.kind === "result" ? outcome : null;
				const event = {
					name,
					is_wait: proc.is_wait,
					outcome: outcome.kind,
					ok: result?.ok ?? null,
					signature: result?.signature ?? null,
					duration_ms: outcome.durationMs,
					timed_out: result?.timedOut ?? false,
					output_path: outcome.outputPath,
				};
				state.log?.write("script", event);
				tracker().apply({ type: "script", ...event });
				if (outcome.kind === "script_error") {
					return reply(`${outcome.text}\nThe script itself is broken; this is not a failed result. If it stays broken, call report_blocked with this message.`, true);
				}
				if (result && !result.ok) failed.set(toolCallId, proc);
				return reply(outcome.text, result?.ok !== true);
			},
		});
		registered.add(name);
	};

	pi.on("tool_execution_end", async (event) => {
		if (!EDIT_TOOLS.includes(event.toolName)) return;
		// durationMs is absent when the call did not run, for example when the guard blocked it.
		tracker().apply({ type: "tool_call", tool: event.toolName, duration_ms: event.durationMs ?? null });
	});

	// The project, and so harness.json, is known only now (logging.ts finds it first).
	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		const earlier = new Set(registered);
		procs = new Map();
		config = null;
		tracked = null;
		if (state.root !== null) {
			try {
				config = loadConfig(state.root, state.harnessDir);
			} catch (e) {
				report(state, `no procedure tools were registered: ${(e as Error).message}`);
			}
		}
		if (config) {
			// Checked against pi's live tool list: a tool of the same name would replace pi's built-in
			// silently, or clash with another extension's tool.
			const taken = new Map(pi.getAllTools().filter((t) => !earlier.has(t.name)).map((t) => [t.name, t.sourceInfo.path]));
			const clashes: string[] = [];
			for (const proc of config.procedures) {
				const owner = taken.get(proc.name);
				if (owner !== undefined) clashes.push(`"${proc.name}" (already a tool from ${owner})`);
				else procs.set(proc.name, proc);
			}
			for (const proc of procs.values()) register(proc);
			if (clashes.length > 0) {
				report(state, `these procedures were not registered as tools, because pi already has tools with their names: ${clashes.join(", ")}. Rename them in harness.json. The other procedures are available.`, "warning");
			}
		}
		// pi cannot unregister a tool. Procedures of an earlier project are taken out of the active
		// set, so the model no longer sees them, and refuse to run if called. A name registered again
		// is not re-activated by pi, so it is put back here.
		if (earlier.size > 0) {
			const active = pi.getActiveTools().filter((name) => !registered.has(name) || procs.has(name));
			pi.setActiveTools([...new Set([...active, ...procs.keys()])]);
		}
	});

	return {
		takeFailed(toolCallId) {
			const proc = failed.get(toolCallId) ?? null;
			failed.delete(toolCallId);
			return proc;
		},
	};
}
