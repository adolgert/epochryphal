#!/usr/bin/env node
// Fake project script. Stands in for check, build, and every other procedure in tests.
//
// Usage: fake-script.mjs <fake dir> <script name> [args...]
//   <fake dir>/behavior.json      { "<script name>": [entry, ...] }
//   <fake dir>/state/<name>       number of calls so far for that name
//   <fake dir>/calls.jsonl        one record per call: name, pid, args, stdin, HARNESS_* env
//   <fake dir>/child-<name>.pid   pid of the child started by an entry with "child"
//
// Each call uses the next entry for its name; the last entry repeats. A name with no entries
// answers { ok: true }. An entry is a script result ({ ok, summary, signature?, ... }) or a mode:
//   { mode: "hang" }                     sleep until killed
//   { mode: "hang", ignore_term: true }  also ignore SIGTERM (needs SIGKILL)
//   { mode: "garbage" }                  print a last line that is not JSON, exit 0
//   { mode: "exit", code: 3 }            exit with that code
//   { mode: "signal", signal: "SIGKILL" } die from that signal
//   { mode: "big", chars: 50000 }        ok result whose summary has that many characters
//   { mode: "wait_for", file: "<path>", ...result }  wait until the file exists, then print the result
// Any entry may add "child": "group" or "escape". Before acting, the script then starts a child
// that sleeps forever and holds the script's stdout and stderr open. "group" keeps the child in
// the script's process group; "escape" puts it in a new session, out of reach of a group kill.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [fakeDir, name, ...args] = process.argv.slice(2);
if (!fakeDir || !name) {
	process.stderr.write("usage: fake-script.mjs <fake dir> <script name> [args...]\n");
	process.exit(64);
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function nextEntry() {
	const behaviorPath = join(fakeDir, "behavior.json");
	const behavior = existsSync(behaviorPath) ? JSON.parse(readFileSync(behaviorPath, "utf8")) : {};
	const entries = behavior[name] ?? [];
	mkdirSync(join(fakeDir, "state"), { recursive: true });
	const counterPath = join(fakeDir, "state", name);
	const count = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
	writeFileSync(counterPath, String(count + 1));
	if (entries.length === 0) return { ok: true, summary: `${name} ok` };
	return entries[Math.min(count, entries.length - 1)];
}

const stdinText = readStdin();
let stdin;
try {
	stdin = JSON.parse(stdinText);
} catch {
	stdin = stdinText;
}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("HARNESS_")));
appendFileSync(join(fakeDir, "calls.jsonl"), JSON.stringify({ name, pid: process.pid, args, stdin, env }) + "\n");

const entry = nextEntry();
process.stdout.write(`fake ${name} ${args.join(" ")}\n`);

if (entry.child) {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
		stdio: ["ignore", "inherit", "inherit"],
		detached: entry.child === "escape",
	});
	child.unref();
	writeFileSync(join(fakeDir, `child-${name}.pid`), String(child.pid));
}

const { mode, child: _child, ignore_term: _ignore, file: _file, ...result } = entry;
switch (mode) {
	case "hang":
		if (entry.ignore_term) process.on("SIGTERM", () => {});
		setInterval(() => {}, 1 << 30);
		break;
	case "garbage":
		process.stdout.write("this is not json\n");
		break;
	case "exit":
		process.stderr.write(`fake ${name}: exiting with ${entry.code}\n`);
		process.exit(entry.code ?? 1);
		break;
	case "signal":
		process.kill(process.pid, entry.signal ?? "SIGKILL");
		setInterval(() => {}, 1 << 30);
		break;
	case "wait_for": {
		const poll = setInterval(() => {
			if (!existsSync(entry.file)) return;
			clearInterval(poll);
			process.stdout.write(JSON.stringify(result) + "\n");
		}, 10);
		break;
	}
	case "big":
		process.stdout.write(JSON.stringify({ ok: true, summary: "x".repeat(entry.chars ?? 10_000) }) + "\n");
		break;
	default:
		process.stdout.write(JSON.stringify(result) + "\n");
}
