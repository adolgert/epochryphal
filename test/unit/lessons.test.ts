// Level 1: lessons in core. Header parsing, loading, matching and bounding, and drafting from a
// fixed list of events.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { draftSources, type Lesson, LessonError, lessonBlock, loadLessons, matchLessons, parseHeader, parseLesson, writeDrafts } from "../../src/core/lessons.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
	const d = mkdtempSync(join(tmpdir(), "harness-lessons-"));
	dirs.push(d);
	return d;
};

const VALID = `---
id: nvfortran-target-data-derived-type
pattern: "NVFORTRAN-S-0155.*derived type"
tools: [build]
compiler: nvfortran 25.9
machine: cluster-a
date: 2026-11-03
evidence: "epoch-11 step s4, commits 3f2a1c..9be0d2"
---
Cause: one or two lines.
Workaround: one or two lines.
`;

/** VALID with header line `key: ...` replaced (or removed when `line` is null). */
const withLine = (key: string, line: string | null) =>
	VALID.split("\n")
		.flatMap((l) => (l.startsWith(`${key}:`) ? (line === null ? [] : [line]) : [l]))
		.join("\n");

const parse = (text: string) => parseLesson(text, "x.md", 1500);

describe("lesson header parsing", () => {
	it("accepts the plan's example lesson", () => {
		const l = parse(VALID);
		expect(l).toMatchObject({ id: "nvfortran-target-data-derived-type", file: "x.md", tools: ["build"], body: "Cause: one or two lines.\nWorkaround: one or two lines." });
		expect(l.pattern.test("NVFORTRAN-S-0155-Derived: derived type not allowed")).toBe(true);
		expect(parseHeader(VALID).fields.get("compiler")).toBe("nvfortran 25.9");
	});

	it("rejects a missing id, a missing pattern, and an invalid regular expression, each with its own message", () => {
		expect(() => parse(withLine("id", null))).toThrow(new LessonError("the header has no id"));
		expect(() => parse(withLine("pattern", null))).toThrow(/^the header has no pattern; add pattern:/);
		expect(() => parse(withLine("pattern", 'pattern: "derived (type"'))).toThrow(/^the pattern is not a valid regular expression: .*Unterminated group/);
	});

	it("rejects an empty pattern, as in a draft moved without filling it in", () => {
		expect(() => parse(withLine("pattern", 'pattern: ""'))).toThrow(/^the pattern is empty; fill in a regular expression .*a draft moved from drafts\/ starts with an empty pattern/);
	});

	it("takes plain values as written and JSON strings with escapes", () => {
		expect(parse(withLine("pattern", "pattern: error \\d+ at line")).pattern.source).toBe("error \\d+ at line");
		expect(parse(withLine("pattern", 'pattern: "error \\\\d+"')).pattern.source).toBe("error \\d+");
		expect(parse(withLine("tools", 'tools: [build, "run_sample"]')).tools).toEqual(["build", "run_sample"]);
		expect(parse(VALID.replace(/\n/g, "\r\n")).id).toBe("nvfortran-target-data-derived-type");
	});

	it("rejects what the small header format does not accept, naming the line", () => {
		const cases: [string, RegExp][] = [
			["no header\n", /must start with a line "---"/],
			["---\nid: a\npattern: x\n", /no closing "---" line/],
			[withLine("machine", "machine cluster-a"), /header line \d+ is not "key: value": machine cluster-a/],
			[withLine("machine", "id: again"), /header line \d+: id is given twice/],
			[withLine("machine", "machine: 'cluster-a'"), /only plain text, "double-quoted" text, and \[a, b\] lists are accepted, not '/],
			[withLine("machine", "machine: |"), /not \|/],
			[withLine("pattern", 'pattern: "a\\d"'), /not a valid JSON string; write a backslash as \\\\/],
			[withLine("tools", "tools: [build"), /a list must end with \]/],
			[withLine("tools", "tools: [[build]]"), /list item "\[build\]" must be a bare word/],
			[withLine("tools", "tools: build"), /tools must be a non-empty list, such as tools: \[build\]/],
			[withLine("tools", "tools: []"), /tools must be a non-empty list/],
			[withLine("tools", null), /the header has no tools/],
			[withLine("pattern", "pattern: [0-9]+ errors"), /a list must end with \]; put text that starts with \[ in double quotes/],
			[withLine("pattern", "pattern: [0-9]"), /the pattern must be text, not a list/],
			[withLine("id", "id: two words"), /the id must be one word/],
			[VALID.replace(/---\nCause[\s\S]*$/, "---\n\n"), /there is no text after the header/],
		];
		for (const [text, message] of cases) expect(() => parse(text), String(message)).toThrow(message);
	});

	it("rejects a lesson that could never fit within max_chars", () => {
		const size = lessonBlock(parse(VALID)).length;
		expect(() => parseLesson(VALID, "x.md", size - 1)).toThrow(`the lesson is ${size} characters with its [lesson nvfortran-target-data-derived-type] line, more than lessons.max_chars (${size - 1})`);
		expect(parseLesson(VALID, "x.md", size).id).toBe("nvfortran-target-data-derived-type");
	});
});

describe("loading lessons", () => {
	it("a missing directory is no lessons and no problems", () => {
		expect(loadLessons(join(tempDir(), "lessons"), 1500)).toEqual({ lessons: [], problems: [] });
	});

	it("loads *.md in file-name order, skips a bad file with its path and problem, and never reads drafts/", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "drafts"));
		writeFileSync(join(dir, "b.md"), withLine("id", "id: second"));
		writeFileSync(join(dir, "a.md"), withLine("id", "id: first"));
		writeFileSync(join(dir, "c.md"), withLine("pattern", null));
		writeFileSync(join(dir, "d.md"), withLine("id", "id: first"));
		writeFileSync(join(dir, "notes.txt"), "not a lesson");
		writeFileSync(join(dir, "drafts", "e.md"), withLine("id", "id: draft"));
		const { lessons, problems } = loadLessons(dir, 1500);
		expect(lessons.map((l) => [l.id, l.file])).toEqual([["first", "a.md"], ["second", "b.md"]]);
		expect(problems).toEqual([
			expect.stringMatching(new RegExp(`^${join(dir, "c.md")}: the header has no pattern`)),
			`${join(dir, "d.md")}: its id first is already used by a.md`,
		]);
	});
});

describe("matching and bounding", () => {
	const lesson = (id: string, pattern: string, tools: string[], body = `Fix for ${id}.`): Lesson => ({ id, file: `${id}.md`, pattern: new RegExp(pattern), tools, body });
	const lessons = [
		lesson("a", "derived type", ["build"]),
		lesson("b", "derived", ["build", "run_sample"]),
		lesson("c", "type", ["run_sample"]),
		lesson("d", "type", ["build"]),
	];
	const ids = (ls: Lesson[]) => ls.map((l) => l.id);

	it("tests only lessons whose tools list has the tool, against the result text", () => {
		expect(ids(matchLessons(lessons, "run_sample", "derived type not allowed", { max_per_result: 9, max_chars: 9999 }))).toEqual(["b", "c"]);
		expect(ids(matchLessons(lessons, "wait_for_job", "derived type not allowed", { max_per_result: 9, max_chars: 9999 }))).toEqual([]);
		expect(ids(matchLessons(lessons, "build", "no match here", { max_per_result: 9, max_chars: 9999 }))).toEqual([]);
	});

	it("takes at most max_per_result, in load order", () => {
		expect(ids(matchLessons(lessons, "build", "derived type", { max_per_result: 2, max_chars: 9999 }))).toEqual(["a", "b"]);
		expect(ids(matchLessons(lessons, "build", "derived type", { max_per_result: 0, max_chars: 9999 }))).toEqual([]);
	});

	it("keeps the appended text within max_chars with whole lessons: one that does not fit is skipped and a later one may fit", () => {
		const big = lesson("big", "x", ["build"], "y".repeat(50));
		const small = lesson("s1", "x", ["build"], "short");
		const small2 = lesson("s2", "x", ["build"], "short");
		const blockLen = lessonBlock(small).length; // "[lesson s1]\nshort" = 17
		expect(ids(matchLessons([small, big, small2], "build", "x", { max_per_result: 3, max_chars: blockLen * 2 + 2 }))).toEqual(["s1", "s2"]);
		// The blank line between two blocks counts: one character short and only the first fits.
		expect(ids(matchLessons([small, small2], "build", "x", { max_per_result: 3, max_chars: blockLen * 2 + 1 }))).toEqual(["s1"]);
	});
});

describe("drafting", () => {
	const triggers = new Set(["build", "run_sample"]);
	let n = 0;
	const script = (name: string, ok: boolean | null, extra: Record<string, unknown> = {}) => ({
		type: "script",
		name,
		ok,
		outcome: ok === null ? "script_error" : "result",
		signature: null,
		output_path: `harness/log/outputs/${++n}-${name}.txt`,
		...extra,
	});

	it("picks a failure that a success of the same procedure followed, and none for a failure with no later success", () => {
		const fail = script("build", false);
		expect(draftSources([fail, script("run_sample", true), script("build", true)], triggers)).toEqual([fail]);
		expect(draftSources([script("build", true), script("build", false), script("run_sample", true)], triggers)).toEqual([]);
	});

	it("one source per procedure and signature, from the first failure; script errors and other procedures do not count", () => {
		const t1 = script("build", false, { signature: "T1" });
		const t2 = script("build", false, { signature: "T2" });
		const none = script("build", false);
		const events = [t1, script("build", false, { signature: "T1" }), t2, none, script("build", false), script("build", null), script("build", true), script("build", false, { signature: "T1" }), script("build", true)];
		expect(draftSources(events, triggers)).toEqual([t1, t2, none]);
		expect(draftSources([script("wait_for_job", false), script("wait_for_job", true)], triggers)).toEqual([]);
		expect(draftSources([script("build", null), script("build", true)], triggers)).toEqual([]);
	});

	const request = (root: string, events: Record<string, unknown>[]) => ({
		root,
		harnessDir: "harness",
		events,
		ref: { plan: "e1", step: "s2", attempt: 1 },
		triggers,
		commits: "3f2a1c000000..9be0d2000000",
		date: "2026-11-10",
	});

	it("writes a draft with an empty pattern, the first 40 lines of the failing output, the step, and the commit range", () => {
		const root = tempDir();
		const fail = script("build", false, { signature: "S-0155" });
		mkdirSync(join(root, "harness/log/outputs"), { recursive: true });
		writeFileSync(join(root, String(fail.output_path)), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
		expect(writeDrafts(request(root, [fail, script("run_sample", true)]))).toEqual({ written: [], problems: [] });
		const { written, problems } = writeDrafts(request(root, [fail, script("build", true)]));
		expect(problems).toEqual([]);
		expect(written).toEqual(["harness/lessons/drafts/e1-s2-a1-build-1.md"]);
		const text = readFileSync(join(root, written[0]!), "utf8");
		expect(text).toBe(
			[
				"---",
				"id: e1-s2-a1-build-1",
				'pattern: ""',
				'tools: ["build"]',
				"date: 2026-11-10",
				'evidence: "plan e1 step s2 attempt 1, commits 3f2a1c000000..9be0d2000000"',
				'signature: "S-0155"',
				"---",
				"Cause: ",
				"Workaround: ",
				"",
				`Failing output of build, first 40 lines of ${fail.output_path}; delete this part when you fill in the lesson:`,
				...Array.from({ length: 40 }, (_, i) => `line ${i + 1}`),
				"",
			].join("\n"),
		);
		// The header parses; moved into lessons/ unchanged, it is refused for its empty pattern.
		expect(parseHeader(text).fields.get("signature")).toBe("S-0155");
		expect(() => parseLesson(text, "moved.md", 5000)).toThrow(/the pattern is empty/);
	});

	it("handles a missing output file, keeps names unique, sanitizes them, and skips a signature an existing draft has", () => {
		const root = tempDir();
		const events = [script("build", false, { signature: "S1" }), script("run_sample", false), script("build", true), script("run_sample", true)];
		const first = writeDrafts(request(root, events));
		expect(first.written).toEqual(["harness/lessons/drafts/e1-s2-a1-build-1.md", "harness/lessons/drafts/e1-s2-a1-run_sample-1.md"]);
		expect(readFileSync(join(root, first.written[0]!), "utf8")).toMatch(/\n\(the output file could not be read: ENOENT[^\n]*\)\n$/);
		// Same events again: build's signature S1 has a draft; run_sample has no signature, so it gets a second file.
		const again = writeDrafts(request(root, events));
		expect(again.written).toEqual(["harness/lessons/drafts/e1-s2-a1-run_sample-2.md"]);
		const odd = writeDrafts({ ...request(root, [script("build", false), script("build", true)]), ref: { plan: "../e 1", step: "s/2", attempt: 3 } });
		expect(odd.written).toEqual(["harness/lessons/drafts/.._e_1-s_2-a3-build-1.md"]);
		expect(readdirSync(join(root, "harness/lessons/drafts")).sort()).toHaveLength(4);
	});

	it("reports a draft it cannot write instead of throwing", () => {
		const root = tempDir();
		mkdirSync(join(root, "harness/lessons"), { recursive: true });
		writeFileSync(join(root, "harness/lessons/drafts"), "a file where the directory should be");
		const r = writeDrafts(request(root, [script("build", false), script("build", true)]));
		expect(r.written).toEqual([]);
		expect(r.problems).toEqual([expect.stringMatching(/^cannot write a lesson draft for build in .*harness\/lessons\/drafts: EEXIST/)]);
	});
});
