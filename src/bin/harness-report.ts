#!/usr/bin/env node
// harness-report --project <dir> [--plan <plan_id>] [--since <date>] [--format md|csv]
// Prints metrics from <dir>/harness/log/steps.jsonl (plan Section 7.11).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readEvents } from "../core/log.ts";
import { type Plan, planProblems } from "../core/plan.ts";
import { formatCsv, formatReport, selectRecords } from "../core/report.ts";
import type { StepRecord } from "../core/steps.ts";

const USAGE = "usage: harness-report --project <dir> [--plan <plan_id>] [--since <date>] [--format md|csv]";

function main(argv: string[]): number {
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: { project: { type: "string" }, plan: { type: "string" }, since: { type: "string" }, format: { type: "string", default: "md" } },
		}));
	} catch (e) {
		process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
		return 1;
	}
	if (!values.project || (values.format !== "md" && values.format !== "csv")) {
		process.stderr.write(`${USAGE}\n`);
		return 1;
	}
	const harness = join(resolve(values.project), "harness");
	if (!existsSync(join(harness, "harness.json"))) {
		process.stderr.write(`harness-report: no harness/harness.json in ${values.project}\n`);
		return 1;
	}
	let records: StepRecord[];
	try {
		records = selectRecords(readEvents(join(harness, "log", "steps.jsonl")) as unknown as StepRecord[], { plan: values.plan, since: values.since });
	} catch (e) {
		process.stderr.write(`harness-report: ${(e as Error).message}\n`);
		return 1;
	}
	if (values.format === "csv") {
		process.stdout.write(formatCsv(records));
		return 0;
	}
	const plans = new Map<string, Plan>();
	for (const id of new Set(records.map((r) => r.plan))) {
		try {
			const value: unknown = JSON.parse(readFileSync(join(harness, "plans", `${id}.json`), "utf8"));
			if (planProblems(value).length === 0) plans.set(id, value as Plan);
		} catch {
			// Shown as "plan file missing or invalid".
		}
	}
	process.stdout.write(formatReport(records, plans));
	return 0;
}

process.exitCode = main(process.argv.slice(2));
