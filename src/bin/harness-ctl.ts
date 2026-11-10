#!/usr/bin/env node
// harness-ctl [--project <dir>] steer "<text>" | stop
// Appends a command to <project>/harness/log/control.jsonl for a running harness-run (plan Section 7.9).
import { parseArgs } from "node:util";
import { appendControl, type ControlCommand, controlPath } from "../core/control.ts";
import { findProjectRoot } from "../core/project.ts";

const USAGE = 'usage: harness-ctl [--project <dir>] steer "<text>" | stop';

function main(argv: string[]): number {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: { project: { type: "string" } }, allowPositionals: true });
	} catch (e) {
		process.stderr.write(`harness-ctl: ${(e as Error).message}\n${USAGE}\n`);
		return 1;
	}
	const [cmd, ...rest] = parsed.positionals;
	const text = rest.join(" ").trim();
	let command: ControlCommand;
	if (cmd === "stop" && rest.length === 0) command = { cmd: "stop" };
	else if (cmd === "steer" && text !== "") command = { cmd: "steer", text };
	else {
		process.stderr.write(`${USAGE}\n`);
		return 1;
	}
	// Without --project, the nearest directory at or above this one that holds harness/harness.json.
	const root = findProjectRoot(parsed.values.project ?? process.cwd());
	if (root === null) {
		process.stderr.write(`harness-ctl: no harness/harness.json at or above ${parsed.values.project ?? process.cwd()}\n`);
		return 1;
	}
	const path = controlPath(root);
	try {
		appendControl(path, command, new Date());
	} catch (e) {
		process.stderr.write(`harness-ctl: cannot write ${path}: ${(e as Error).message}\n`);
		return 1;
	}
	process.stdout.write(`harness-ctl: ${cmd} written to ${path}; a running harness-run reads it within a second.\n`);
	return 0;
}

process.exitCode = main(process.argv.slice(2));
