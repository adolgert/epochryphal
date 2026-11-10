// Level 3: harness-report as a subprocess on a toy project holding the fixed steps.jsonl of the
// level 1 report test.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

const BIN = new URL("../../src/bin/harness-report.ts", import.meta.url).pathname;
const FIXTURES = new URL("../unit/fixtures/report/", import.meta.url).pathname;

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

/** Run harness-report with Node, which strips the TypeScript types itself (Node 22.18 and later). */
function report(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [BIN, ...args], (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
	});
}

function projectWithRecords(): ToyProject {
	const t = makeToyProject();
	mkdirSync(join(t.dir, "harness/log"), { recursive: true });
	cpSync(join(FIXTURES, "steps.jsonl"), join(t.dir, "harness/log/steps.jsonl"));
	cpSync(join(FIXTURES, "plans"), join(t.dir, "harness/plans"), { recursive: true });
	return t;
}

describe("harness-report", () => {
	it("prints the Markdown report, and CSV with --format csv", async () => {
		toy = projectWithRecords();
		const md = await report(["--project", toy.dir]);
		expect(md).toMatchObject({ code: 0, stdout: readFileSync(join(FIXTURES, "expected.md"), "utf8") });
		const csv = await report(["--project", toy.dir, "--format", "csv", "--plan", "e1", "--since", "2026-11-10"]);
		expect(csv.code).toBe(0);
		expect(csv.stdout.split("\n").slice(1, 4).map((l) => l.split(",").slice(0, 2).join(","))).toEqual(["measure,2", "offload,2", "restructure,3"]);
	});

	it("exits with 1 and a message for a missing project or a bad option", async () => {
		toy = makeToyProject();
		expect(await report([])).toMatchObject({ code: 1, stderr: expect.stringMatching(/usage: harness-report --project <dir>/) });
		expect(await report(["--project", toy.workDir])).toMatchObject({ code: 1, stderr: expect.stringMatching(/no harness\/harness.json in/) });
		expect(await report(["--project", toy.dir, "--since", "soon"])).toMatchObject({ code: 1, stderr: expect.stringMatching(/--since "soon" is not a date/) });
		expect(await report(["--project", toy.dir, "--colour"])).toMatchObject({ code: 1, stderr: expect.stringMatching(/Unknown option '--colour'/) });
	});
});
