// Level 3: harness-run and harness-ctl as subprocesses, run by Node directly (it strips the types),
// and a session file written by harness-run opened with the pi executable.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addStep, newPlan, PlanStore } from "../../src/core/plan.ts";
import { runPiCli } from "../rig/cli.ts";
import { SCRIPTED_MODEL_PATH, type ScriptEntry, scrubbedEnv, writeScript } from "../rig/script.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

const RUN = new URL("../../src/bin/harness-run.ts", import.meta.url).pathname;
const CTL = new URL("../../src/bin/harness-ctl.ts", import.meta.url).pathname;

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

function node(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<Result> {
	return new Promise((resolve) => {
		const child = execFile(process.execPath, args, { env, cwd, timeout: 15_000 }, (error, stdout, stderr) =>
			resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
		);
		child.stdin?.end();
	});
}

/** A toy project with plan e1 and one pending measure step. */
function project(): ToyProject {
	const t = makeToyProject();
	const store = new PlanStore(t.dir);
	store.create(addStep(newPlan("e1", "Goal", new Date()), { kind: "measure", goal: "Profile it" }).plan);
	store.setActive("e1");
	return t;
}

/** harness-run on the toy project with the scripted model and a scrubbed environment. */
async function harnessRun(t: ToyProject, script: ScriptEntry[], extra: string[] = []): Promise<Result & { sessionDir: string }> {
	const work = join(t.workDir, `run-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(join(work, "agent"), { recursive: true });
	const { scriptPath, requestsPath } = writeScript(work, script);
	const sessionDir = join(work, "sessions");
	const env = {
		...scrubbedEnv(),
		PI_CODING_AGENT_DIR: join(work, "agent"),
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		HARNESS_TEST_SCRIPT: scriptPath,
		HARNESS_TEST_REQUESTS: requestsPath,
	};
	const args = [RUN, "--project", t.dir, "--plan", "e1", "--model", "scripted/scripted-1", "--extension", SCRIPTED_MODEL_PATH, "--session-dir", sessionDir, ...extra];
	return { ...(await node(args, env)), sessionDir };
}

describe("harness-run", () => {
	it("exits 0 when the step passes and 2 when it ends blocked, with the live feed on standard output", async () => {
		toy = project();
		const passed = await harnessRun(toy, [{ tool: "submit" }]);
		expect(passed.stderr).toBe("");
		expect(passed.code).toBe(0);
		expect(passed.stdout).toMatch(/^\d\d:\d\d:\d\d s1 step_end passed \| 110 tokens \$0\.0015$/m);
		toy.cleanup();
		toy = project();
		const blocked = await harnessRun(toy, [{ tool: "report_blocked", args: { reason: "no GPU node" } }]);
		expect(blocked.code).toBe(2);
		expect(blocked.stderr).toMatch(/harness-run: step s1 ended blocked \(no GPU node\)\. The run ends here/);
	});

	it("exits 1 with the usage for bad arguments", async () => {
		toy = project();
		const missing = await node([RUN, "--project", toy.dir], scrubbedEnv());
		expect(missing).toMatchObject({ code: 1, stderr: expect.stringMatching(/--project, --plan, and --model are required\nusage: harness-run/) });
		const steps = await node([RUN, "--project", toy.dir, "--plan", "e1", "--model", "a/b", "--steps", "0"], scrubbedEnv());
		expect(steps).toMatchObject({ code: 1, stderr: expect.stringMatching(/--steps must be a whole number/) });
	});

	it("a session file written by harness-run opens with the pi executable, which continues it", async () => {
		toy = project();
		const run = await harnessRun(toy, [{ tool: "submit" }]);
		expect(run.code).toBe(0);
		const files = readdirSync(run.sessionDir).filter((f) => f.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		const file = join(run.sessionDir, files[0]!);
		expect(run.stdout).toContain(`harness-run: session file ${file}`);
		const pi = await runPiCli({ project: toy, script: [{ text: "Continued." }], prompt: "continue please", args: ["--session", file], sessionDir: run.sessionDir });
		expect(pi.exitCode).toBe(0);
		const messages = pi.requests()[0]!.messages;
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(JSON.stringify(messages[0]!.content)).toContain("[harness step s1 | kind: measure | plan: e1]");
		expect(readFileSync(file, "utf8")).toContain("continue please");
	});
});

describe("harness-ctl", () => {
	it("appends steer and stop lines to the control file; bad usage exits 1", async () => {
		toy = project();
		const env = scrubbedEnv();
		expect(await node([CTL, "--project", toy.dir, "steer", "Use", "the GPU build."], env)).toMatchObject({ code: 0 });
		expect(await node([CTL, "stop"], env, join(toy.dir, "src"))).toMatchObject({ code: 0 });
		const lines = readFileSync(join(toy.dir, "harness/log/control.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines).toEqual([
			{ ts: expect.any(String), cmd: "steer", text: "Use the GPU build." },
			{ ts: expect.any(String), cmd: "stop" },
		]);
		expect(await node([CTL, "--project", toy.dir, "steer"], env)).toMatchObject({ code: 1, stderr: expect.stringMatching(/^usage: harness-ctl/) });
		expect(await node([CTL, "--project", toy.workDir, "stop"], env)).toMatchObject({ code: 1, stderr: expect.stringMatching(/no harness\/harness.json at or above/) });
	});
});
