// The headless runner's live feed (plan Section 7.9): one line per logged event with the time, the
// step, the type, a short description, and the run's token and cost total so far.
type Event = Record<string, unknown>;

export interface FeedTotals {
	tokens: number;
	cost_usd: number;
}

const MAX_DESCRIPTION = 120;
const firstLine = (v: unknown) => String(v ?? "").split("\n")[0]!;
const join = (...parts: unknown[]) => parts.filter((p) => p !== null && p !== undefined && p !== "").join(" ");

function describe(e: Event): string {
	switch (e.type) {
		case "session_start":
		case "session_end":
			return String(e.reason ?? "");
		case "step_start":
			return `${e.kind}: ${e.goal}`;
		case "step_end":
			return join(e.outcome, e.detail ? `(${e.detail})` : null);
		case "model_call":
			return `${e.model} ${e.total_tokens} tokens`;
		case "tool_call":
			return join(e.tool, e.is_error ? "(error)" : null);
		case "script":
			return join(e.name, e.outcome === "result" ? (e.ok ? "ok" : "failed") : e.outcome, e.signature ? `[${e.signature}]` : null);
		case "check":
			return join(`by ${e.by}:`, e.outcome === "result" ? (e.ok ? "passed" : "failed") : e.outcome, "-", firstLine(e.summary));
		case "interruption":
			return join(e.how, e.reason ? `labeled ${e.reason}` : null, e.text_head ? `- ${firstLine(e.text_head)}` : null);
		case "guard_block":
			return `${e.tool} ${e.path}`;
		case "protected_changed":
			return Array.isArray(e.paths) ? e.paths.join(", ") : "";
		case "plan_changed_externally":
			return String(e.plan ?? "");
		case "rule_tripped":
			return join(e.rule, e.action, e.value !== null && e.value !== undefined ? `(${e.value} of ${e.limit})` : null);
		case "proposal":
			return `${e.proposal_id} ${e.action}`;
		default:
			return "";
	}
}

/** Add a model call to `totals` (in place), then format the line. */
export function feedLine(e: Event, totals: FeedTotals): string {
	if (e.type === "model_call") {
		totals.tokens += typeof e.total_tokens === "number" ? e.total_tokens : 0;
		totals.cost_usd += typeof e.cost_usd === "number" ? e.cost_usd : 0;
	}
	const time = typeof e.ts === "string" ? e.ts.slice(11, 19) : "--:--:--";
	let text = describe(e);
	if (text.length > MAX_DESCRIPTION) text = `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
	const cost = Math.round(totals.cost_usd * 10_000) / 10_000;
	return `${time} ${e.step ?? "-"} ${e.type} ${text}`.trimEnd() + ` | ${totals.tokens} tokens $${cost}`;
}
