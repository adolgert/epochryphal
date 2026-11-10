// Level 1: the report of plan Section 7.11, from a fixed steps.jsonl of twelve records. The expected
// outputs in fixtures/report/ were written by hand from the records, not produced by the code.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../src/core/log.ts";
import { type Plan, planProblems } from "../../src/core/plan.ts";
import { formatCsv, formatReport, selectRecords } from "../../src/core/report.ts";
import type { StepRecord } from "../../src/core/steps.ts";

const FIXTURES = new URL("./fixtures/report/", import.meta.url).pathname;
const records = readEvents(`${FIXTURES}steps.jsonl`) as unknown as StepRecord[];
const plan = (id: string) => JSON.parse(readFileSync(`${FIXTURES}plans/${id}.json`, "utf8")) as Plan;
const plans = new Map([
	["e1", plan("e1")],
	["e2", plan("e2")],
]);

describe("report", () => {
	it("the fixture plans are valid plan files", () => {
		expect(planProblems(plan("e1"))).toEqual([]);
		expect(planProblems(plan("e2"))).toEqual([]);
	});

	it("prints the expected numbers per kind, interruptions, stop rules, and plans", () => {
		expect(records).toHaveLength(12);
		expect(formatReport(records, plans)).toBe(readFileSync(`${FIXTURES}expected.md`, "utf8"));
	});

	it("prints the per-kind table as CSV", () => {
		expect(formatCsv(records)).toBe(readFileSync(`${FIXTURES}expected.csv`, "utf8"));
	});

	it("filters by plan and by date", () => {
		expect(selectRecords(records, { plan: "e2" }).map((r) => r.step)).toEqual(["s1", "s4", "s2", "s3", "s5"]);
		expect(selectRecords(records, { since: "2026-11-10T18:00:00Z" }).map((r) => `${r.step}/${r.attempt}`)).toEqual(["s4/1", "s4/2", "s5/1"]);
		expect(() => selectRecords(records, { since: "last week" })).toThrow(/--since "last week" is not a date/);
	});

	it("says so when no record matches, and marks a plan whose file is missing", () => {
		expect(formatReport([], plans)).toBe("# Harness report\n\nNo step records match.\n");
		const only = selectRecords(records, { plan: "e2" });
		expect(formatReport(only, new Map())).toContain("| e2 | ? | ? | ? | ? | plan file missing or invalid |");
		expect(formatReport(records.filter((r) => r.kind === "measure"), plans)).toContain("## Stop rules\n\nNo step was stopped by a rule.\n");
	});
});
