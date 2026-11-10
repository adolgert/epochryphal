// The script contract (plan Section 6): how the harness runs every project script.
// A check and a procedure are run the same way; only the caller differs.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { type Clock, systemClock } from "./clock.ts";

/** Sent to the script as JSON on standard input, and as HARNESS_* environment variables. */
export interface ScriptInput {
	params: Record<string, unknown>;
	plan: string | null;
	step: string | null;
	attempt: number | null;
	kind: string | null;
}

export interface RunScriptOptions {
	/** Project root; the working directory of the script. */
	cwd: string;
	/** Short name used in the output file name, such as "build" or "check". */
	name: string;
	timeoutMs: number;
	maxSummaryChars: number;
	/** Directory for the full output of each call. */
	outputDir: string;
	signal?: AbortSignal;
	/** Time between the terminate signal and the kill signal. Default 5000 ms. */
	killGraceMs?: number;
	/**
	 * After the script exits, how long to wait for its output pipes to close. A child the script
	 * left running can hold them open; output written after this window is lost. Default 2000 ms.
	 */
	drainMs?: number;
	clock?: Clock;
}

interface Common {
	/** Text for the agent. */
	text: string;
	durationMs: number;
	/** Full output of the call, relative to cwd. */
	outputPath: string;
}

/** The script ran and reported a result, or the harness stopped it at its time limit. */
export interface ScriptResult extends Common {
	kind: "result";
	ok: boolean;
	summary: string;
	signature: string | null;
	detailsPath: string | null;
	data: unknown;
	timedOut: boolean;
}

/** The script itself is broken: it did not start, exited nonzero or by a signal, or printed no valid result. */
export interface ScriptError extends Common {
	kind: "script_error";
	error: string;
	exitCode: number | null;
}

/** The run was aborted (by the person or the harness) before the script finished. Not a failed result. */
export interface ScriptAborted extends Common {
	kind: "aborted";
}

export type ScriptOutcome = ScriptResult | ScriptError | ScriptAborted;

const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_DRAIN_MS = 2000;
/** Characters of standard output kept in memory to find the last line. A longer last line is a script error. */
const TAIL_CHARS = 1 << 20;

// Process groups of scripts still running. If the harness process exits, or is told to by a
// signal, they get the terminate signal. A SIGKILL of the harness cannot be caught.
const liveGroups = new Set<number>();
let exitHooksInstalled = false;

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(-pgid, sig);
	} catch {
		// The group has already exited.
	}
}

function installExitHooks(): void {
	if (exitHooksInstalled) return;
	exitHooksInstalled = true;
	const terminateAll = () => {
		for (const pgid of liveGroups) signalGroup(pgid, "SIGTERM");
	};
	process.on("exit", terminateAll);
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		const onSignal = () => {
			terminateAll();
			// If this is the only handler, listening has replaced Node's default of exiting: restore it.
			if (process.listenerCount(sig) === 1) {
				process.removeListener(sig, onSignal);
				process.kill(process.pid, sig);
			}
		};
		process.on(sig, onSignal);
	}
}

export function formatLimit(ms: number): string {
	if (ms >= 60_000) {
		const minutes = Math.round((ms / 60_000) * 10) / 10;
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const seconds = Math.round((ms / 1000) * 10) / 10;
	return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** Cut text to `max` characters; when cut, end with a line that says how much and where the rest is. */
export function boundText(text: string, max: number, outputPath: string): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[${text.length - max} characters removed; full output: ${outputPath}]`;
}

/** A path under outputDir that no earlier call used. */
function outputFile(outputDir: string, startMs: number, name: string): string {
	mkdirSync(outputDir, { recursive: true });
	const stamp = new Date(startMs).toISOString().replace(/[:.]/g, "-");
	for (let n = 0; ; n++) {
		const path = join(outputDir, `${stamp}-${n === 0 ? "" : `${n}-`}${name}.txt`);
		if (!existsSync(path)) return path;
	}
}

type Parsed = Pick<ScriptResult, "ok" | "summary" | "signature" | "detailsPath" | "data">;

/** Parse the last non-empty line of standard output as a result object; a string is an error. */
function parseResult(stdoutTail: string): Parsed | string {
	const lines = stdoutTail.split("\n").filter((line) => line.trim() !== "");
	const last = lines.at(-1);
	if (last === undefined) return "the script printed nothing; its last line must be a JSON result";
	let value: unknown;
	try {
		value = JSON.parse(last);
	} catch {
		return `the last line of output is not JSON: ${last.slice(0, 200)}`;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "the last line of output is not a JSON object";
	const r = value as Record<string, unknown>;
	if (typeof r.ok !== "boolean") return 'the result has no boolean "ok" field';
	if (typeof r.summary !== "string") return 'the result has no string "summary" field';
	// null is how many languages say "absent"; treat it so.
	if (r.signature != null && typeof r.signature !== "string") return 'the result\'s "signature" is not a string';
	if (r.details_path != null && typeof r.details_path !== "string") return 'the result\'s "details_path" is not a string';
	return {
		ok: r.ok,
		summary: r.summary,
		signature: typeof r.signature === "string" && r.signature !== "" ? r.signature : null,
		detailsPath: typeof r.details_path === "string" ? r.details_path : null,
		data: r.data ?? null,
	};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Run `command` (no shell) in `options.cwd` under the script contract. Never throws for anything
 * the script does; every failure is a ScriptOutcome.
 */
export async function runScript(command: readonly string[], input: ScriptInput, options: RunScriptOptions): Promise<ScriptOutcome> {
	const clock = options.clock ?? systemClock;
	const start = clock.now();
	const outputAbs = outputFile(options.outputDir, start, options.name);
	const outputPath = relative(options.cwd, outputAbs);

	// The full output goes to the file as it arrives, so it can be read during a long run.
	const fd = openSync(outputAbs, "w");
	const append = (text: string) => {
		try {
			writeSync(fd, text);
		} catch {
			// A full disk must not stop the script; the tail in memory still decides the result.
		}
	};
	append(`$ ${command.join(" ")}\n`);
	const finish = <T extends ScriptOutcome>(outcome: Omit<T, "durationMs" | "outputPath">, footer: string): T => {
		append(`\n# ${footer}\n`);
		closeSync(fd);
		return { ...outcome, durationMs: clock.now() - start, outputPath } as T;
	};
	const aborted = () => finish<ScriptAborted>({ kind: "aborted", text: "The script was aborted before it finished." }, "aborted");
	const scriptError = (error: string, exitCode: number | null) =>
		finish<ScriptError>(
			{ kind: "script_error", error, exitCode, text: `The script itself failed (${command.join(" ")}): ${error}. Full output: ${outputPath}` },
			`script error: ${error}`,
		);

	if (options.signal?.aborted) return aborted();
	const [program, ...args] = command;
	if (program === undefined) return scriptError("the command is empty", null);

	installExitHooks();
	const env = {
		...process.env,
		HARNESS_PLAN: input.plan ?? "",
		HARNESS_STEP: input.step ?? "",
		HARNESS_ATTEMPT: input.attempt === null ? "" : String(input.attempt),
		HARNESS_KIND: input.kind ?? "",
	};
	// Own process group, so a signal to the group also reaches anything the script started.
	const child = spawn(program, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
	const pgid = child.pid;
	if (pgid !== undefined) liveGroups.add(pgid);

	let tail = "";
	child.stdout.setEncoding("utf8").on("data", (d: string) => {
		append(d);
		tail += d;
		if (tail.length > 2 * TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
	});
	child.stderr.setEncoding("utf8").on("data", (d: string) => append(d));
	child.stdin.on("error", () => {}); // The script need not read its input.
	child.stdin.end(JSON.stringify(input));

	let stopReason: "timeout" | "aborted" | null = null;
	const stop = (reason: "timeout" | "aborted") => {
		if (stopReason !== null || pgid === undefined) return;
		stopReason = reason;
		signalGroup(pgid, "SIGTERM");
		// Left running after the script exits, so members of the group that ignore SIGTERM still die.
		setTimeout(() => signalGroup(pgid, "SIGKILL"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS).unref();
	};
	const limitTimer = setTimeout(() => stop("timeout"), options.timeoutMs);
	const onAbort = () => stop("aborted");
	options.signal?.addEventListener("abort", onAbort, { once: true });

	// Wait for the script's own exit, not for its pipes to close: a child it left behind may hold them.
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
		child.once("error", (err) => resolve({ code: null, signal: null, spawnError: err }));
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	clearTimeout(limitTimer);
	options.signal?.removeEventListener("abort", onAbort);
	await Promise.race([closed, sleep(options.drainMs ?? DEFAULT_DRAIN_MS)]);
	child.stdout.destroy();
	child.stderr.destroy();
	if (pgid !== undefined) liveGroups.delete(pgid);

	if (stopReason === "aborted") return aborted();
	if (stopReason === "timeout") {
		const summary = `timed out after ${formatLimit(options.timeoutMs)}`;
		return finish<ScriptResult>(
			{ kind: "result", ok: false, summary, text: summary, signature: "timeout", detailsPath: null, data: null, timedOut: true },
			summary,
		);
	}
	if (exit.spawnError) return scriptError(`could not start ${program}: ${exit.spawnError.message}`, null);
	if (exit.signal !== null) return scriptError(`killed by ${exit.signal}`, null);
	if (exit.code !== 0) return scriptError(`exit code ${exit.code}`, exit.code);

	const parsed = parseResult(tail);
	if (typeof parsed === "string") return scriptError(parsed, 0);
	return finish<ScriptResult>(
		{ kind: "result", ...parsed, text: boundText(parsed.summary, options.maxSummaryChars, outputPath), timedOut: false },
		`exit 0; ok: ${parsed.ok}`,
	);
}
