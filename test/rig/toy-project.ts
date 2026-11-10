// Toy project: a temporary git repository with a harness/ directory whose scripts all run the fake.
//
//   <root>/project/   the project (git repository, one commit)
//   <root>/fake/      fake-script state, outside the project so it never shows in git status
//   <root>/work/      scratch space for helpers (scripts, request records, pi config dirs)
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_SCRIPT = new URL("./fake-script.mjs", import.meta.url).pathname;

export type FakeEntry = Record<string, unknown>;
export type Behavior = Record<string, FakeEntry[]>;

export interface ScriptCall {
	name: string;
	args: string[];
	stdin: unknown;
	env: Record<string, string>;
}

export interface ToyProjectOptions {
	/** What each fake script returns, by script name. */
	behavior?: Behavior;
	/** Top-level fields that replace those of the default harness.json. */
	config?: Record<string, unknown>;
}

export interface ToyProject {
	root: string;
	/** The project directory (git repository). */
	dir: string;
	/** Fake-script state directory, outside `dir`. */
	fakeDir: string;
	/** Scratch directory for test helpers, outside `dir`. */
	workDir: string;
	setBehavior(behavior: Behavior): void;
	scriptCalls(): ScriptCall[];
	readConfig(): Record<string, unknown>;
	readPlan(planId: string): unknown;
	readEvents(): Record<string, unknown>[];
	readSteps(): Record<string, unknown>[];
	git(...args: string[]): string;
	cleanup(): void;
}

/** Script names that the default configuration points at. */
const SCRIPT_NAMES = ["check", "build", "run_sample", "wait_for_job"];

export function defaultConfig(): Record<string, unknown> {
	const budget = { tokens: 1_000_000, cost_usd: 10, agent_minutes: 60, check_attempts: 5 };
	return {
		version: 1,
		max_summary_chars: 2000,
		protected: ["harness/harness.json", "harness/scripts/**", "harness/lessons/**", "tests/**"],
		kinds: {
			restructure: { description: "Change structure, same results.", check: ["harness/scripts/check", "restructure"], check_timeout_s: 60, budget },
			offload: { description: "Move a region to the GPU.", check: ["harness/scripts/check", "offload"], check_timeout_s: 60, budget },
			measure: { description: "Record a profile.", check: ["harness/scripts/check", "measure"], check_timeout_s: 60, budget },
		},
		procedures: [
			{
				name: "build",
				description: "Build the code.",
				command: ["harness/scripts/build"],
				params: { variant: { type: "string", enum: ["cpu", "gpu"], description: "Which build." } },
				timeout_s: 60,
				is_wait: false,
				requires: [],
				lesson_trigger: true,
			},
			{
				name: "run_sample",
				description: "Run the sample workload.",
				command: ["harness/scripts/run_sample"],
				params: {},
				timeout_s: 60,
				is_wait: false,
				requires: ["build"],
				lesson_trigger: true,
			},
			{
				name: "wait_for_job",
				description: "Wait for a queued job.",
				command: ["harness/scripts/wait_for_job"],
				params: { job_id: { type: "string", description: "Job id." } },
				timeout_s: 60,
				is_wait: true,
				requires: [],
				lesson_trigger: false,
			},
		],
		rules: { supervised: "warn", run_plan: "stop", headless: "stop", max_iterations: 3 },
		run_plan: { approve: "ask" },
		headless: { session_mode: "fresh_per_step" },
		lessons: { max_per_result: 2, max_chars: 1500 },
	};
}

function readJsonl(path: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function makeToyProject(options: ToyProjectOptions = {}): ToyProject {
	const root = mkdtempSync(join(tmpdir(), "harness-toy-"));
	const dir = join(root, "project");
	const fakeDir = join(root, "fake");
	const workDir = join(root, "work");
	for (const d of [dir, fakeDir, workDir, join(dir, "src"), join(dir, "tests"), join(dir, "harness/scripts")]) {
		mkdirSync(d, { recursive: true });
	}

	const write = (rel: string, text: string) => writeFileSync(join(dir, rel), text);
	write("src/solver.txt", "solve the tridiagonal system\n");
	write("src/driver.txt", "call solver for each column\n");
	write("tests/test_solver.txt", "expect residual below 1e-12\n");
	write(".gitignore", "harness/log/\n");
	write("harness/harness.json", JSON.stringify({ ...defaultConfig(), ...options.config }, null, 2) + "\n");
	for (const name of SCRIPT_NAMES) {
		const path = join(dir, "harness/scripts", name);
		writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SCRIPT}" "${fakeDir}" ${name} "$@"\n`);
		chmodSync(path, 0o755);
	}

	const setBehavior = (behavior: Behavior) => {
		writeFileSync(join(fakeDir, "behavior.json"), JSON.stringify(behavior, null, 2));
		rmSync(join(fakeDir, "state"), { recursive: true, force: true });
	};
	setBehavior(options.behavior ?? {});

	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	git("-c", "user.name=toy", "-c", "user.email=toy@example.invalid", "add", ".");
	git("-c", "user.name=toy", "-c", "user.email=toy@example.invalid", "commit", "-q", "-m", "toy project");

	return {
		root,
		dir,
		fakeDir,
		workDir,
		setBehavior,
		scriptCalls: () => readJsonl(join(fakeDir, "calls.jsonl")) as unknown as ScriptCall[],
		readConfig: () => JSON.parse(readFileSync(join(dir, "harness/harness.json"), "utf8")),
		readPlan: (planId: string) => JSON.parse(readFileSync(join(dir, "harness/plans", `${planId}.json`), "utf8")),
		readEvents: () => readJsonl(join(dir, "harness/log/events.jsonl")),
		readSteps: () => readJsonl(join(dir, "harness/log/steps.jsonl")),
		git,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
