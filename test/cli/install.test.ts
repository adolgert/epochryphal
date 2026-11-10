// Level 3: the package installed the way the README says, into temporary directories.
// - The bins: `npm install -g --prefix <tmp> <checkout>` links the checkout, and the linked
//   harness-report, harness-ctl, and harness-run run (Node strips their types, because the real
//   path is the checkout, not a node_modules directory).
// - The extension: `pi install <checkout>` with a temporary pi configuration directory, after which
//   pi loads the extension from the package's "pi" manifest without -e, and without the warning
//   about host-provided packages in "dependencies".
import { execFile, type ExecFileOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addStep, newPlan, PlanStore } from "../../src/core/plan.ts";
import { PI_BIN } from "../rig/cli.ts";
import { SCRIPTED_MODEL_PATH, scrubbedEnv, writeScript } from "../rig/script.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

const CHECKOUT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

let toy: ToyProject | undefined;
const dirs: string[] = [];
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

function run(file: string, args: string[], options: ExecFileOptions): Promise<Result> {
	return new Promise((resolve) => {
		const child = execFile(file, args, { timeout: 30_000, encoding: "utf8", ...options }, (error, stdout, stderr) =>
			resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
		);
		child.stdin?.end();
	});
}

/** A scrubbed environment whose PATH finds this Node (22.18 or later) and npm first. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const base = scrubbedEnv();
	return { ...base, PATH: `${dirname(process.execPath)}${delimiter}${base.PATH ?? ""}`, npm_config_update_notifier: "false", ...extra };
}

const temp = (prefix: string) => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
};

describe("installed from a checkout", () => {
	it("npm install -g of the checkout puts working harness-report, harness-ctl, and harness-run on the PATH", async () => {
		toy = makeToyProject();
		const store = new PlanStore(toy.dir);
		store.create(addStep(newPlan("e1", "Goal", new Date()), { kind: "measure", goal: "Profile it" }).plan);
		store.setActive("e1");
		const prefix = temp("harness-prefix-");
		const install = await run("npm", ["install", "-g", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", CHECKOUT], { env: env() });
		expect(install, install.stderr).toMatchObject({ code: 0 });
		const bin = (name: string) => join(prefix, "bin", name);
		const e = env({ PATH: `${join(prefix, "bin")}${delimiter}${env().PATH}` });

		const report = await run(bin("harness-report"), ["--project", toy.dir], { env: e });
		expect(report).toMatchObject({ code: 0, stdout: "# Harness report\n\nNo step records match.\n" });

		const ctl = await run(bin("harness-ctl"), ["stop"], { env: e, cwd: toy.dir });
		expect(ctl.code).toBe(0);
		expect(readFileSync(join(toy.dir, "harness/log/control.jsonl"), "utf8")).toMatch(/"cmd":"stop"/);

		// harness-run imports pi's SDK: a bad argument is reported only after that import succeeded.
		const bad = await run(bin("harness-run"), ["--project", toy.dir, "--plan", "e9", "--model", "scripted/scripted-1"], { env: e });
		expect(bad).toMatchObject({ code: 1, stderr: expect.stringMatching(/^harness-run: no plan e9 in /) });

		// And a whole run with the scripted model.
		const work = temp("harness-run-");
		mkdirSync(join(work, "agent"));
		const { scriptPath, requestsPath } = writeScript(work, [{ tool: "submit" }]);
		const runEnv = { ...e, PI_CODING_AGENT_DIR: join(work, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", HARNESS_TEST_SCRIPT: scriptPath, HARNESS_TEST_REQUESTS: requestsPath };
		const args = ["--project", toy.dir, "--plan", "e1", "--model", "scripted/scripted-1", "--extension", SCRIPTED_MODEL_PATH, "--session-dir", join(work, "sessions")];
		const passed = await run(bin("harness-run"), args, { env: runEnv });
		expect(passed, passed.stderr).toMatchObject({ code: 0, stdout: expect.stringMatching(/ s1 step_end passed /) });
	});

	it("pi install of the checkout makes pi load the extension from its manifest, with no warning", async () => {
		toy = makeToyProject();
		const agentDir = temp("harness-pi-agent-");
		const piEnv = env({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
		const install = await run(PI_BIN, ["install", CHECKOUT], { env: piEnv });
		expect(install, install.stderr).toMatchObject({ code: 0 });
		const list = await run(PI_BIN, ["list"], { env: piEnv });
		expect(list.stdout).toContain(CHECKOUT);

		const work = temp("harness-pi-run-");
		const { scriptPath, requestsPath } = writeScript(work, [{ tool: "harness_ping" }, { text: "done" }]);
		// No --no-extensions and no -e for the harness: it must come from the installed package.
		const args = ["-e", SCRIPTED_MODEL_PATH, "--model", "scripted/scripted-1", "--mode", "json", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--offline", "--", "ping"];
		const ping = await run(PI_BIN, args, { env: { ...piEnv, HARNESS_TEST_SCRIPT: scriptPath, HARNESS_TEST_REQUESTS: requestsPath }, cwd: toy.dir });
		expect(ping.code).toBe(0);
		expect(ping.stderr).not.toMatch(/Host-provided extension packages/);
		const results = ping.stdout
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l) as Record<string, any>)
			.filter((e) => e.type === "tool_execution_end");
		expect(results).toMatchObject([{ toolName: "harness_ping", isError: false }]);
		expect(readFileSync(join(toy.dir, "harness/log/events.jsonl"), "utf8")).toMatch(/"type":"session_start"/);
	});
});
