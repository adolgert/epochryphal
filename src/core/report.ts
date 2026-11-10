// The report (plan Section 7.11): metrics from harness/log/steps.jsonl and the plan files.
import type { Plan } from "./plan.ts";
import { INTERRUPTION_REASONS, type StepRecord } from "./steps.ts";

export interface ReportFilter {
	plan?: string;
	/** Keep records whose end time is at or after this date. */
	since?: string;
}

export function selectRecords(records: readonly StepRecord[], filter: ReportFilter): StepRecord[] {
	const since = filter.since === undefined ? undefined : Date.parse(filter.since);
	if (since !== undefined && Number.isNaN(since)) throw new Error(`--since "${filter.since}" is not a date; use a form like 2026-11-10`);
	return records.filter((r) => (filter.plan === undefined || r.plan === filter.plan) && (since === undefined || Date.parse(r.ts) >= since));
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const OUTCOMES = ["passed", "blocked", "abandoned", "stopped"] as const;

interface KindRow {
	kind: string;
	attempts: number;
	counts: Record<(typeof OUTCOMES)[number], number>;
	completion: number;
	unaided: number;
	tokens: number;
	cost: number;
	minutes: number;
	checks: number;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
	return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Per kind: completion rate is passed attempts over all attempts; unaided rate is passed attempts
 * with no interruptions over all attempts.
 */
export function kindRows(records: readonly StepRecord[]): KindRow[] {
	return [...groupBy(records, (r) => r.kind)].map(([kind, rs]) => {
		const counts = { passed: 0, blocked: 0, abandoned: 0, stopped: 0 };
		for (const r of rs) counts[r.outcome]++;
		return {
			kind,
			attempts: rs.length,
			counts,
			completion: counts.passed / rs.length,
			unaided: rs.filter((r) => r.outcome === "passed" && r.interruptions === 0).length / rs.length,
			tokens: median(rs.map((r) => r.tokens)),
			cost: median(rs.map((r) => r.cost_usd)),
			minutes: median(rs.map((r) => r.agent_minutes)),
			checks: median(rs.map((r) => r.check_attempts)),
		};
	});
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const table = (header: string[], rows: (string | number)[][]) =>
	[`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** The report as Markdown. `plans` holds the plan files of the plans in `records`, when found. */
export function formatReport(records: readonly StepRecord[], plans: ReadonlyMap<string, Plan>): string {
	if (records.length === 0) return "# Harness report\n\nNo step records match.\n";
	const out = [`# Harness report`, "", `${records.length} step attempts, ${records[0]!.ts} to ${records.at(-1)!.ts}.`, "", "## Per kind", ""];
	out.push(
		table(
			["kind", "attempts", ...OUTCOMES, "completion", "unaided", "median tokens", "median cost", "median agent min", "median checks"],
			kindRows(records).map((k) => [
				k.kind,
				k.attempts,
				...OUTCOMES.map((o) => k.counts[o]),
				pct(k.completion),
				pct(k.unaided),
				Math.round(k.tokens),
				`$${k.cost.toFixed(2)}`,
				k.minutes.toFixed(1),
				k.checks,
			]),
		),
	);

	const found = new Set(records.flatMap((r) => Object.keys(r.interruptions_by_reason)));
	const reasons = [...INTERRUPTION_REASONS, "unlabeled", ...[...found].filter((r) => !INTERRUPTION_REASONS.includes(r) && r !== "unlabeled").sort()];
	const interruptionRow = (label: string, rs: readonly StepRecord[]) => [
		label,
		rs.reduce((t, r) => t + r.interruptions, 0),
		...reasons.map((reason) => rs.reduce((t, r) => t + (r.interruptions_by_reason[reason] ?? 0), 0)),
	];
	out.push("", "## Interruptions", "");
	out.push(table(["kind", "total", ...reasons], [...[...groupBy(records, (r) => r.kind)].map(([k, rs]) => interruptionRow(k, rs)), interruptionRow("all", records)]));

	const stopped = records.filter((r) => r.stop_rule !== null);
	out.push("", "## Stop rules", "");
	out.push(stopped.length === 0 ? "No step was stopped by a rule." : table(["rule", "count"], [...groupBy(stopped, (r) => r.stop_rule!)].map(([rule, rs]) => [rule, rs.length])));

	out.push("", "## Per plan", "");
	const planRows = [...groupBy(records, (r) => r.plan).keys()].map((id) => {
		const p = plans.get(id);
		if (!p) return [id, "?", "?", "?", "?", "plan file missing or invalid"];
		const proposals = (state: string) => p.proposals.filter((x) => x.state === state).length;
		return [id, p.steps.length, p.steps.filter((s) => s.origin.startsWith("proposal:")).length, proposals("accepted"), proposals("rejected"), p.exit?.decision ?? "open"];
	});
	out.push(table(["plan", "steps", "from proposals", "proposals accepted", "proposals rejected", "decision"], planRows));
	return out.join("\n") + "\n";
}

/** The per-kind table as CSV, for spreadsheets. Rates are fractions; cost is in dollars. */
export function formatCsv(records: readonly StepRecord[]): string {
	const header = ["kind", "attempts", ...OUTCOMES, "completion_rate", "unaided_rate", "median_tokens", "median_cost_usd", "median_agent_minutes", "median_check_attempts"];
	const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
	const rows = kindRows(records).map((k) => [k.kind, k.attempts, ...OUTCOMES.map((o) => k.counts[o]), r4(k.completion), r4(k.unaided), k.tokens, r4(k.cost), k.minutes, k.checks]);
	return [header, ...rows].map((r) => r.join(",")).join("\n") + "\n";
}
