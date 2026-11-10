// Level 1: the template harness/ directory loads with the real configuration loader, each stub
// script returns a valid result under the script contract, and the example lesson loads and
// matches. The README carries the AGENTS.md snippet word for word.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.ts";
import { loadLessons, matchLessons } from "../../src/core/lessons.ts";
import { runScript } from "../../src/core/script.ts";

/** The template's project root: it holds harness/ and AGENTS.md. */
const TEMPLATE = new URL("../../template/", import.meta.url).pathname;
const README = new URL("../../README.md", import.meta.url).pathname;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("template/harness", () => {
	it("harness.json passes loadConfig, including the check that every script exists and is executable", () => {
		const config = loadConfig(TEMPLATE);
		expect(Object.keys(config.kinds)).toEqual(["restructure", "offload", "measure"]);
		expect(config.procedures.map((p) => p.name)).toEqual(["build", "run_sample"]);
	});

	it("every check and procedure stub prints a valid result", async () => {
		const config = loadConfig(TEMPLATE);
		const out = mkdtempSync(join(tmpdir(), "harness-template-"));
		dirs.push(out);
		const commands: [string, string[], Record<string, unknown>][] = [
			...Object.entries(config.kinds).map(([kind, k]): [string, string[], Record<string, unknown>] => [kind, [...k.check, "R17"], {}]),
			...config.procedures.map((p): [string, string[], Record<string, unknown>] => [p.name, p.command, p.name === "build" ? { variant: "cpu" } : {}]),
		];
		for (const [name, command, params] of commands) {
			const outcome = await runScript(command, { params, plan: "demo", step: "s1", attempt: 1, kind: "measure" }, {
				cwd: TEMPLATE,
				name,
				timeoutMs: 10_000,
				maxSummaryChars: config.max_summary_chars,
				outputDir: out,
			});
			expect(outcome, name).toMatchObject({ kind: "result", ok: true, summary: expect.stringMatching(/^Stub /) });
		}
	});

	it("the example lesson loads and matches a failed build", () => {
		const config = loadConfig(TEMPLATE);
		const { lessons, problems } = loadLessons(join(TEMPLATE, "harness/lessons"), config.lessons.max_chars);
		expect(problems).toEqual([]);
		expect(lessons.map((l) => l.id)).toEqual(["example-build-missing-module"]);
		const failure = "main.f90:3: Fatal Error: Cannot open module file 'solver_mod.mod' for reading";
		expect(matchLessons(lessons, "build", failure, config.lessons).map((l) => l.id)).toEqual(["example-build-missing-module"]);
		expect(matchLessons(lessons, "run_sample", failure, config.lessons)).toEqual([]);
	});

	it("ignores the log directory, and the README holds the AGENTS.md snippet as it is in the template", () => {
		expect(readFileSync(join(TEMPLATE, "harness/.gitignore"), "utf8")).toMatch(/^log\/$/m);
		const snippet = readFileSync(join(TEMPLATE, "AGENTS.md"), "utf8");
		expect(snippet.trimEnd().split("\n")).toHaveLength(5);
		expect(readFileSync(README, "utf8")).toContain(snippet);
	});
});
