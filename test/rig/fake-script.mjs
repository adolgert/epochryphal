#!/usr/bin/env node
// Fake project script. Stands in for check, build, and every other procedure in tests.
//
// Usage: fake-script.mjs <fake dir> <script name> [args...]
//   <fake dir>/behavior.json  { "<script name>": [entry, ...] }
//   <fake dir>/state/<name>   number of calls so far for that name
//   <fake dir>/calls.jsonl    one record per call: name, args, stdin, HARNESS_* env
//
// Each call uses the next entry for its name; the last entry repeats. A name with no entries
// answers { ok: true }. An entry is a script result ({ ok, summary, signature?, ... }) or a mode:
//   { mode: "hang" }               sleep until killed
//   { mode: "garbage" }            print a last line that is not JSON, exit 0
//   { mode: "exit", code: 3 }      exit with that code
//   { mode: "big", chars: 50000 }  ok result whose summary has that many characters
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
appendFileSync(join(fakeDir, "calls.jsonl"), JSON.stringify({ name, args, stdin, env }) + "\n");

const entry = nextEntry();
process.stdout.write(`fake ${name} ${args.join(" ")}\n`);

switch (entry.mode) {
	case "hang":
		setInterval(() => {}, 1 << 30);
		break;
	case "garbage":
		process.stdout.write("this is not json\n");
		break;
	case "exit":
		process.stderr.write(`fake ${name}: exiting with ${entry.code}\n`);
		process.exit(entry.code ?? 1);
		break;
	case "big":
		process.stdout.write(JSON.stringify({ ok: true, summary: "x".repeat(entry.chars ?? 10_000) }) + "\n");
		break;
	default: {
		const { mode: _mode, ...result } = entry;
		process.stdout.write(JSON.stringify(result) + "\n");
	}
}
