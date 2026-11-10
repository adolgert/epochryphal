// The event log, harness/log/events.jsonl (plan Section 5.3): one JSON object per line, append-only.
// Writing must never break the agent's work: failures are caught and the first one is reported.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Clock, systemClock } from "./clock.ts";
import type { ScriptOutcome } from "./script.ts";

export type ScriptOutcomeKind = ScriptOutcome["kind"];

export type Mode = "supervised" | "run_plan" | "headless";

export type InterruptionHow = "steer" | "follow_up" | "idle_message" | "abort" | "control";

/** The step attempt an event belongs to. */
export interface StepRef {
	plan: string;
	step: string;
	attempt: number;
}

/** Values every record carries, read at the moment of writing. */
export interface LogContext {
	session: string | null;
	mode: Mode;
	step: StepRef | null;
}

/** Extra fields for each event type (plan Section 5.3). */
export interface EventFields {
	session_start: { reason: string };
	session_end: { reason: string };
	/** `commit` is the git commit when the step started, the base of the protected-file check. */
	step_start: { kind: string; goal: string; origin: string; commit: string };
	step_end: { outcome: "passed" | "blocked" | "abandoned" | "stopped"; detail: string | null };
	/**
	 * One assistant message, or a model call pi makes outside the agent loop: then `stop_reason` is
	 * "compaction" or "branch_summary".
	 */
	model_call: {
		model: string;
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
		total_tokens: number;
		cost_usd: number;
		stop_reason: string;
	};
	/** `parent` is the id of the tool call that made this call, null for a call the model made. */
	tool_call: { tool: string; args_summary: string; duration_ms: number | null; is_error: boolean; parent: string | null };
	/**
	 * `ok` is null when the script produced no result (outcome script_error or aborted).
	 * `is_wait` marks a procedure whose time is waiting; it counts as wait_minutes, not agent_minutes.
	 */
	script: {
		name: string;
		is_wait: boolean;
		outcome: ScriptOutcomeKind;
		ok: boolean | null;
		signature: string | null;
		duration_ms: number;
		timed_out: boolean;
		output_path: string;
	};
	/**
	 * `ok` is null when the check produced no result (outcome script_error or aborted). `tree` is a
	 * fingerprint of the working tree (protect.ts treeFingerprint) taken at a failed check, for the
	 * stall rule; null otherwise, or when git could not compute it.
	 */
	check: {
		outcome: ScriptOutcomeKind;
		ok: boolean | null;
		signature: string | null;
		summary: string;
		duration_ms: number;
		by: "submit" | "runner";
		tree: string | null;
	};
	/**
	 * A label written by /why has `label_of` set to the number (1, 2, ...) of the interruption it
	 * labels, counted within the step attempt. An interruption itself has `label_of` null.
	 */
	interruption: {
		how: InterruptionHow;
		text_head: string | null;
		reason: string | null;
		note: string | null;
		label_of: number | null;
	};
	guard_block: { tool: string; path: string };
	protected_changed: { paths: string[] };
	plan_changed_externally: { plan: string };
	/** `value` and `limit` are null for rules without a measured quantity, such as stall. */
	rule_tripped: { rule: string; action: "warn" | "stop"; value: number | null; limit: number | null };
	proposal: { proposal_id: string; action: "proposed" | "accepted" | "rejected" };
	lesson_injected: { lesson_id: string; tool: string };
	lesson_drafted: { path: string };
}

export type EventType = keyof EventFields;

export interface EventLogOptions {
	path: string;
	context: () => LogContext;
	clock?: Clock;
	/** Called with the first write failure only. */
	onFirstError?: (error: Error) => void;
	/**
	 * Called with each record, whether or not it reached the file, so in-memory state that follows
	 * the log (the budget tracker) keeps working when the disk fails. Its errors are ignored.
	 */
	onWrite?: (record: Record<string, unknown>) => void;
}

/** First `max` characters of a value's JSON form. */
export function summarize(value: unknown, max = 200): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		text = String(value);
	}
	return text.length <= max ? text : text.slice(0, max);
}

export class EventLog {
	readonly path: string;
	private readonly context: () => LogContext;
	private readonly clock: Clock;
	private readonly onFirstError?: (error: Error) => void;
	private readonly onWrite?: (record: Record<string, unknown>) => void;
	private failed = false;

	constructor(options: EventLogOptions) {
		this.path = options.path;
		this.context = options.context;
		this.clock = options.clock ?? systemClock;
		this.onFirstError = options.onFirstError;
		this.onWrite = options.onWrite;
	}

	/** Append one record. Never throws. */
	write<T extends EventType>(type: T, fields: EventFields[T]): void {
		let record: Record<string, unknown> | undefined;
		try {
			const { session, mode, step } = this.context();
			record = {
				ts: new Date(this.clock.now()).toISOString(),
				session,
				mode,
				plan: step?.plan ?? null,
				step: step?.step ?? null,
				attempt: step?.attempt ?? null,
				type,
				...fields,
			};
			mkdirSync(dirname(this.path), { recursive: true });
			appendFileSync(this.path, JSON.stringify(record) + "\n");
		} catch (e) {
			if (this.failed) return;
			this.failed = true;
			try {
				this.onFirstError?.(e instanceof Error ? e : new Error(String(e)));
			} catch {
				// Reporting must not throw either.
			}
		} finally {
			try {
				if (record) this.onWrite?.(record);
			} catch {
				// Followers must not break logging.
			}
		}
	}
}

/** The records of an event log, oldest first. Lines that are not JSON objects are skipped. */
export function readEvents(path: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	const records: Record<string, unknown>[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && !Array.isArray(value)) records.push(value as Record<string, unknown>);
		} catch {
			// An empty or partly written line.
		}
	}
	return records;
}
