// The `requires` rule for procedure tools (plan Section 7.3): a procedure runs only after each
// procedure it requires has succeeded in the same step attempt, with no file edit by the agent since.
// The tracker reads event-log records, so the live updates and a rebuild from the log follow one rule.

type Event = Record<string, unknown>;

/** pi's built-in tools that change files. Edits made through the shell are not seen. */
export const EDIT_TOOLS = ["edit", "write"];

export class RequiresTracker {
	private readonly succeeded = new Set<string>();

	/**
	 * Feed one event-log record (or a record of the same shape).
	 * - `script`: the procedure's latest run decides. A success records it; a failure, a script
	 *   error, or an abort removes it, since a failed build may have left the old one half-replaced.
	 * - `tool_call` of edit or write that ran (duration_ms set), at any nesting depth, with or
	 *   without an error: forgets every success. An edit that reports an error may still have
	 *   written the file (pi checks for an abort after writing). A call a guard blocked did not run.
	 */
	apply(e: Event): void {
		if (e.type === "script" && typeof e.name === "string") {
			if (e.outcome === "result" && e.ok === true) this.succeeded.add(e.name);
			else this.succeeded.delete(e.name);
		} else if (e.type === "tool_call" && EDIT_TOOLS.includes(String(e.tool)) && typeof e.duration_ms === "number") {
			this.succeeded.clear();
		}
	}

	/** The required procedures that have not succeeded since the last edit, in the order given. */
	missing(requires: readonly string[]): string[] {
		return requires.filter((name) => !this.succeeded.has(name));
	}
}

/** A tracker rebuilt from the events of one step attempt, oldest first. */
export function trackerFromEvents(events: readonly Event[]): RequiresTracker {
	const tracker = new RequiresTracker();
	for (const e of events) tracker.apply(e);
	return tracker;
}
