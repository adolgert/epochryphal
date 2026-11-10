// The control file, harness/log/control.jsonl (plan Section 7.9): commands for a running headless
// run, one JSON object per line: {"ts": "<ISO time>", "cmd": "steer", "text": "..."} or
// {"ts": "<ISO time>", "cmd": "stop"}. harness-ctl appends; the runner reads only lines added
// after it started, by polling the file's size (fs.watch is unreliable on network file systems).
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type ControlCommand = { cmd: "steer"; text: string } | { cmd: "stop" };

export const controlPath = (root: string, harnessDir = "harness"): string => join(root, harnessDir, "log", "control.jsonl");

export function appendControl(path: string, command: ControlCommand, now: Date): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, JSON.stringify({ ts: now.toISOString(), ...command }) + "\n");
}

/** One line as a command, or a message saying what is wrong with it. */
export function parseControlLine(line: string): ControlCommand | string {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return `not JSON: ${line.slice(0, 80)}`;
	}
	const v = value as Record<string, unknown> | null;
	if (v?.cmd === "stop") return { cmd: "stop" };
	if (v?.cmd === "steer" && typeof v.text === "string" && v.text.trim() !== "") return { cmd: "steer", text: v.text };
	return `expected {"cmd": "stop"} or {"cmd": "steer", "text": "..."}: ${line.slice(0, 80)}`;
}

const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);

/** Reads lines appended to the control file after it was created. */
export class ControlReader {
	readonly path: string;
	private offset: number;

	constructor(path: string) {
		this.path = path;
		this.offset = sizeOf(path); // Lines already there are from before this run.
	}

	/** Commands in complete lines added since the last call; a partly written last line waits. */
	poll(): { commands: ControlCommand[]; problems: string[] } {
		const size = sizeOf(this.path);
		if (size < this.offset) this.offset = 0; // The file was truncated or replaced: all of it is new.
		if (size === this.offset) return { commands: [], problems: [] };
		const buffer = Buffer.alloc(size - this.offset);
		const fd = openSync(this.path, "r");
		try {
			readSync(fd, buffer, 0, buffer.length, this.offset);
		} finally {
			closeSync(fd);
		}
		const end = buffer.lastIndexOf(0x0a);
		if (end < 0) return { commands: [], problems: [] };
		this.offset += end + 1;
		const commands: ControlCommand[] = [];
		const problems: string[] = [];
		for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
			if (line.trim() === "") continue;
			const c = parseControlLine(line);
			if (typeof c === "string") problems.push(`${this.path}: ignored a line, ${c}`);
			else commands.push(c);
		}
		return { commands, problems };
	}
}
