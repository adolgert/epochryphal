// Level 1: the control file (core/control.ts) and the live feed's lines (core/feed.ts).
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendControl, ControlReader, parseControlLine } from "../../src/core/control.ts";
import { type FeedTotals, feedLine } from "../../src/core/feed.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});
const tempFile = () => {
	dir = mkdtempSync(join(tmpdir(), "harness-control-"));
	mkdirSync(join(dir, "log"));
	return join(dir, "log", "control.jsonl");
};

describe("control file", () => {
	it("harness-ctl's line format: one JSON object per line with ts and cmd", () => {
		const path = tempFile();
		appendControl(path, { cmd: "steer", text: "Use the GPU build." }, new Date("2026-11-10T14:00:00Z"));
		appendControl(path, { cmd: "stop" }, new Date("2026-11-10T14:00:01Z"));
		expect(readFileSync(path, "utf8")).toBe(
			'{"ts":"2026-11-10T14:00:00.000Z","cmd":"steer","text":"Use the GPU build."}\n{"ts":"2026-11-10T14:00:01.000Z","cmd":"stop"}\n',
		);
	});

	it("the reader ignores lines written before it was made, and reads each later line once", () => {
		const path = tempFile();
		appendControl(path, { cmd: "stop" }, new Date());
		const reader = new ControlReader(path);
		expect(reader.poll()).toEqual({ commands: [], problems: [] });
		appendControl(path, { cmd: "steer", text: "hello" }, new Date());
		expect(reader.poll().commands).toEqual([{ cmd: "steer", text: "hello" }]);
		expect(reader.poll().commands).toEqual([]);
	});

	it("works when the file does not exist yet, and waits for a partly written line", () => {
		const path = tempFile();
		const reader = new ControlReader(path);
		expect(reader.poll().commands).toEqual([]);
		appendControl(path, { cmd: "steer", text: "first" }, new Date());
		appendFileSync(path, '{"cmd":"st');
		expect(reader.poll().commands).toEqual([{ cmd: "steer", text: "first" }]);
		appendFileSync(path, 'op"}\n');
		expect(reader.poll().commands).toEqual([{ cmd: "stop" }]);
	});

	it("reports bad lines and skips them; a truncated file is read again from the start", () => {
		const path = tempFile();
		const reader = new ControlReader(path);
		appendFileSync(path, 'nonsense\n{"cmd":"steer","text":"  "}\n{"cmd":"stop"}\n');
		const { commands, problems } = reader.poll();
		expect(commands).toEqual([{ cmd: "stop" }]);
		expect(problems).toEqual([expect.stringMatching(/ignored a line, not JSON: nonsense/), expect.stringMatching(/ignored a line, expected \{"cmd": "stop"\}/)]);
		writeFileSync(path, '{"cmd":"stop"}\n');
		expect(reader.poll().commands).toEqual([{ cmd: "stop" }]);
	});

	it("parses each command", () => {
		expect(parseControlLine('{"cmd":"stop","ts":"x"}')).toEqual({ cmd: "stop" });
		expect(parseControlLine('{"cmd":"steer","text":"go"}')).toEqual({ cmd: "steer", text: "go" });
		expect(parseControlLine('{"cmd":"pause"}')).toMatch(/^expected/);
	});
});

describe("live feed", () => {
	const base = { ts: "2026-11-10T14:05:09.120Z", step: "s2" };

	it("one line per event: time, step, type, a short description, and the running totals", () => {
		const totals: FeedTotals = { tokens: 0, cost_usd: 0 };
		expect(feedLine({ ...base, step: null, type: "session_start", reason: "startup" }, totals)).toBe("14:05:09 - session_start startup | 0 tokens $0");
		expect(feedLine({ ...base, type: "model_call", model: "p/m", total_tokens: 110, cost_usd: 0.0015 }, totals)).toBe("14:05:09 s2 model_call p/m 110 tokens | 110 tokens $0.0015");
		expect(feedLine({ ...base, type: "model_call", model: "p/m", total_tokens: 110, cost_usd: 0.0015 }, totals)).toMatch(/\| 220 tokens \$0\.003$/);
		expect(feedLine({ ...base, type: "check", by: "runner", outcome: "result", ok: false, summary: "2 tests failed\nmore" }, totals)).toBe(
			"14:05:09 s2 check by runner: failed - 2 tests failed | 220 tokens $0.003",
		);
		expect(feedLine({ ...base, type: "rule_tripped", rule: "budget_tokens", action: "stop", value: 220, limit: 150 }, totals)).toMatch(/rule_tripped budget_tokens stop \(220 of 150\) \|/);
		expect(feedLine({ ...base, type: "interruption", how: "control", text_head: "Use the GPU" }, totals)).toMatch(/interruption control - Use the GPU \|/);
		expect(feedLine({ ...base, type: "step_end", outcome: "stopped", detail: "stop rule stall: x" }, totals)).toMatch(/step_end stopped \(stop rule stall: x\) \|/);
	});

	it("cuts a long description", () => {
		const line = feedLine({ ...base, type: "step_start", kind: "measure", goal: "g".repeat(500) }, { tokens: 0, cost_usd: 0 });
		expect(line.length).toBeLessThan(200);
		expect(line).toMatch(/…\s\|/);
	});
});
