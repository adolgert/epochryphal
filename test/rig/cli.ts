// Level 3 helper: run the pinned pi executable as a subprocess with the scripted model.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ModelRequest, readRequests, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PATH, SCRIPTED_PROVIDER, type ScriptEntry, scrubbedEnv, writeScript } from "./script.ts";
import { EXTENSION_PATH } from "./sdk-session.ts";
import type { ToyProject } from "./toy-project.ts";

/** The pi executable from this package's node_modules, so its version is the pinned one. */
export const PI_BIN = new URL("../../node_modules/.bin/pi", import.meta.url).pathname;

export interface PiCliOptions {
	project: ToyProject;
	script: ScriptEntry[];
	/** One or more prompts; pi runs them in order. */
	prompt: string | string[];
	/** Load the harness extension with -e. Default true. The scripted model always loads. */
	loadExtension?: boolean;
	/** Extra command-line arguments, placed before the prompts. */
	args?: string[];
	/** Default "json". */
	mode?: "json" | "print";
	/** Store sessions in this directory. Default: --no-session. */
	sessionDir?: string;
	/** Working directory for pi. Default: the project directory. */
	cwd?: string;
	/** Kill pi after this long. Default 15 s. */
	timeoutMs?: number;
}

export interface PiCliResult {
	exitCode: number | null;
	/** Parsed JSON lines from standard output (json mode). */
	events: Record<string, any>[];
	stdout: string;
	stderr: string;
	requests(): ModelRequest[];
}

export async function runPiCli(options: PiCliOptions): Promise<PiCliResult> {
	const work = join(options.project.workDir, `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const agentDir = join(work, "pi-agent");
	mkdirSync(agentDir, { recursive: true });
	const { scriptPath, requestsPath } = writeScript(work, options.script);

	const extensions = [...(options.loadExtension === false ? [] : [EXTENSION_PATH]), SCRIPTED_MODEL_PATH];
	const prompts = Array.isArray(options.prompt) ? options.prompt : [options.prompt];
	const args = [
		"--no-extensions",
		...extensions.flatMap((path) => ["-e", path]),
		"--model",
		`${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL_ID}`,
		"--mode",
		options.mode ?? "json",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--offline",
		...(options.sessionDir ? ["--session-dir", options.sessionDir] : ["--no-session"]),
		...(options.args ?? []),
		"--",
		...prompts,
	];
	const env = {
		...scrubbedEnv(),
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		HARNESS_TEST_SCRIPT: scriptPath,
		HARNESS_TEST_REQUESTS: requestsPath,
	};

	// stdin must not be an open pipe: pi would wait for it to close (docs/pi-facts.md, change 3).
	const child = spawn(PI_BIN, args, { cwd: options.cwd ?? options.project.dir, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
	child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
	const timeoutMs = options.timeoutMs ?? 15_000;
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve(code));
	}).finally(() => clearTimeout(timer));

	const events: Record<string, any>[] = [];
	if ((options.mode ?? "json") === "json") {
		for (const line of stdout.split("\n")) {
			if (line.trim() === "") continue;
			try {
				events.push(JSON.parse(line));
			} catch {
				throw new Error(`runPiCli: standard output line is not JSON: ${line.slice(0, 200)}\nstderr:\n${stderr}`);
			}
		}
	}
	return { exitCode, events, stdout, stderr, requests: () => readRequests(requestsPath) };
}
