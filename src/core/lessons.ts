// Lessons (plan Section 7.10): stored notes about past failures, shown to the agent when a failed
// procedure result matches one, and drafts written from a passed step's events for a person to fill in.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Event = Record<string, unknown>;

/** A lesson file that cannot be used, with the reason. */
export class LessonError extends Error {
	override name = "LessonError";
}

export interface Lesson {
	id: string;
	/** File name within the lessons directory. */
	file: string;
	pattern: RegExp;
	tools: string[];
	body: string;
}

/** Drafts live here, relative to the project root. They are never loaded. */
export const draftsDir = (harnessDir: string) => `${harnessDir}/lessons/drafts`;

/**
 * The header of a lesson file. This is a small fixed format, not YAML: the file starts with a line
 * "---", then one `key: value` per line until the next "---" line; blank lines are skipped. A value
 * is plain text (trimmed, taken as written, so a backslash is just a backslash), a JSON string in
 * double quotes, or a list `[a, b]` whose items are bare words (letters, digits, . _ -) or JSON
 * strings. Anything else, such as single quotes, `{}`, `|`, or `>`, is refused.
 */
export function parseHeader(text: string): { fields: Map<string, string | string[]>; body: string } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[0]?.trimEnd() !== "---") throw new LessonError('the file must start with a line "---" that opens the header');
	const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
	if (close < 0) throw new LessonError('the header has no closing "---" line');
	const fields = new Map<string, string | string[]>();
	for (let i = 1; i < close; i++) {
		const line = lines[i]!;
		if (line.trim() === "") continue;
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
		if (!m) throw new LessonError(`header line ${i + 1} is not "key: value": ${line}`);
		const [, key, raw] = m as unknown as [string, string, string];
		if (fields.has(key)) throw new LessonError(`header line ${i + 1}: ${key} is given twice`);
		fields.set(key, headerValue(raw.trim(), `header line ${i + 1} (${key})`));
	}
	return { fields, body: lines.slice(close + 1).join("\n").trim() };
}

function quoted(value: string, where: string): string {
	try {
		const v: unknown = JSON.parse(value);
		if (typeof v === "string") return v;
	} catch {
		// Reported below.
	}
	throw new LessonError(`${where}: ${value} starts with a double quote but is not a valid JSON string; write a backslash as \\\\, or leave out the quotes`);
}

function headerValue(value: string, where: string): string | string[] {
	if (value.startsWith('"')) return quoted(value, where);
	if (/^['{|>]/.test(value)) throw new LessonError(`${where}: only plain text, "double-quoted" text, and [a, b] lists are accepted, not ${value[0]}`);
	if (!value.startsWith("[")) return value;
	if (!value.endsWith("]")) throw new LessonError(`${where}: a list must end with ]; put text that starts with [ in double quotes`);
	const inner = value.slice(1, -1).trim();
	if (inner === "") return [];
	return inner.split(",").map((item) => {
		const t = item.trim();
		if (t.startsWith('"')) return quoted(t, where);
		if (/^[A-Za-z0-9._-]+$/.test(t)) return t;
		throw new LessonError(`${where}: list item "${t}" must be a bare word (letters, digits, . _ -) or a JSON string; lists cannot nest`);
	});
}

/** The text appended to a tool result for one lesson. */
export const lessonBlock = (l: Pick<Lesson, "id" | "body">) => `[lesson ${l.id}]\n${l.body}`;

/**
 * A lesson from the text of `file`. Requires id, pattern (a valid, non-empty regular expression,
 * used with no flags), tools (a non-empty list), and text after the header. Other header fields
 * (compiler, machine, date, evidence, ...) are free. A lesson whose block is longer than
 * `maxChars` could never be shown, so it is refused here.
 */
export function parseLesson(text: string, file: string, maxChars: number): Lesson {
	const { fields, body } = parseHeader(text);
	const id = fields.get("id");
	if (id === undefined) throw new LessonError("the header has no id");
	if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/.test(id)) throw new LessonError(`the id must be one word of letters, digits, . _ -, not ${JSON.stringify(id)}`);
	const pattern = fields.get("pattern");
	if (pattern === undefined) throw new LessonError("the header has no pattern; add pattern: <regular expression that matches the failing output>");
	if (typeof pattern !== "string") throw new LessonError("the pattern must be text, not a list; put a pattern that starts with [ in double quotes");
	if (pattern === "") throw new LessonError("the pattern is empty; fill in a regular expression that matches the failing output (a draft moved from drafts/ starts with an empty pattern)");
	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch (e) {
		throw new LessonError(`the pattern is not a valid regular expression: ${(e as Error).message}`);
	}
	const tools = fields.get("tools");
	if (tools === undefined) throw new LessonError("the header has no tools; add tools: [<procedure name>, ...]");
	if (!Array.isArray(tools) || tools.length === 0) throw new LessonError("tools must be a non-empty list, such as tools: [build]");
	if (body === "") throw new LessonError("there is no text after the header");
	const size = lessonBlock({ id, body }).length;
	if (size > maxChars) throw new LessonError(`the lesson is ${size} characters with its [lesson ${id}] line, more than lessons.max_chars (${maxChars}), so it could never be shown; shorten it or raise max_chars`);
	return { id, file, pattern: re, tools, body };
}

/**
 * The lessons in `dir` (*.md files directly in it, by file name; drafts/ is not read), and one
 * problem per file that was skipped. A missing directory is normal: no lessons, no problems.
 */
export function loadLessons(dir: string, maxChars: number): { lessons: Lesson[]; problems: string[] } {
	const lessons: Lesson[] = [];
	const problems: string[] = [];
	if (!existsSync(dir)) return { lessons, problems };
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
		const path = join(dir, file);
		try {
			if (!statSync(path).isFile()) continue;
			const lesson = parseLesson(readFileSync(path, "utf8"), file, maxChars);
			const twin = lessons.find((l) => l.id === lesson.id);
			if (twin) throw new LessonError(`its id ${lesson.id} is already used by ${twin.file}`);
			lessons.push(lesson);
		} catch (e) {
			problems.push(`${path}: ${(e as Error).message}`);
		}
	}
	return { lessons, problems };
}

/**
 * The lessons to append to a failed result of `tool` whose text is `text`: in load order, those
 * whose tools list has the tool and whose pattern matches, at most `maxPerResult`. Lessons are
 * shown whole: one that would take the appended text (the blocks joined by a blank line) past
 * `maxChars` is skipped, and a later, shorter one may still fit.
 */
export function matchLessons(lessons: readonly Lesson[], tool: string, text: string, limits: { max_per_result: number; max_chars: number }): Lesson[] {
	const chosen: Lesson[] = [];
	let used = 0;
	for (const l of lessons) {
		if (chosen.length >= limits.max_per_result) break;
		if (!l.tools.includes(tool) || !l.pattern.test(text)) continue;
		const cost = lessonBlock(l).length + (chosen.length > 0 ? 2 : 0);
		if (used + cost > limits.max_chars) continue;
		chosen.push(l);
		used += cost;
	}
	return chosen;
}

/**
 * The procedure failures of one attempt's events that deserve a draft: a failed result (not a
 * script error) of a procedure in `triggers` that a success of the same procedure followed. One per
 * procedure and signature (no signature counts as one signature), from its first such failure.
 */
export function draftSources(events: readonly Event[], triggers: ReadonlySet<string>): Event[] {
	const pending = new Map<string, Event>();
	const done = new Set<string>();
	const out: Event[] = [];
	for (const e of events) {
		if (e.type !== "script" || e.outcome !== "result" || !triggers.has(String(e.name))) continue;
		if (e.ok === false) {
			const key = `${String(e.name)}\0${typeof e.signature === "string" ? e.signature : ""}`;
			if (!pending.has(key) && !done.has(key)) pending.set(key, e);
		} else if (e.ok === true) {
			for (const [key, f] of pending) {
				if (f.name !== e.name) continue;
				out.push(f);
				done.add(key);
				pending.delete(key);
			}
		}
	}
	return out;
}

export interface DraftRequest {
	root: string;
	harnessDir: string;
	/** The attempt's events, oldest first. */
	events: readonly Event[];
	ref: { plan: string; step: string; attempt: number };
	triggers: ReadonlySet<string>;
	/** "<base>..<head>", or a note that it is unknown. */
	commits: string;
	date: string;
}

const firstLines = (root: string, path: string, n: number): string => {
	try {
		return readFileSync(join(root, path), "utf8").split("\n").slice(0, n).join("\n").trimEnd();
	} catch (e) {
		return `(the output file could not be read: ${(e as Error).message})`;
	}
};

/**
 * Write a draft for each of draftSources(), skipping one whose procedure and non-empty signature
 * an existing draft already has. Returns the paths written, relative to the root, and a problem
 * per draft that could not be written. Never throws for one draft's failure.
 */
export function writeDrafts(req: DraftRequest): { written: string[]; problems: string[] } {
	const rel = draftsDir(req.harnessDir);
	const dir = join(req.root, rel);
	const written: string[] = [];
	const problems: string[] = [];
	const sources = draftSources(req.events, req.triggers);
	if (sources.length === 0) return { written, problems };
	const known = existingDrafts(dir);
	for (const f of sources) {
		const name = String(f.name);
		const signature = typeof f.signature === "string" ? f.signature : "";
		if (signature !== "" && known.has(`${name}\0${signature}`)) continue;
		const stem = `${req.ref.plan}-${req.ref.step}-a${req.ref.attempt}-${name}`.replace(/[^A-Za-z0-9._-]/g, "_");
		const output = typeof f.output_path === "string" ? f.output_path : "";
		try {
			mkdirSync(dir, { recursive: true });
			for (let n = 1; ; n++) {
				const id = `${stem}-${n}`;
				const text = [
					"---",
					`id: ${id}`,
					'pattern: ""',
					`tools: [${JSON.stringify(name)}]`,
					`date: ${req.date}`,
					`evidence: ${JSON.stringify(`plan ${req.ref.plan} step ${req.ref.step} attempt ${req.ref.attempt}, commits ${req.commits}`)}`,
					`signature: ${JSON.stringify(signature)}`,
					"---",
					"Cause: ",
					"Workaround: ",
					"",
					`Failing output of ${name}, first 40 lines of ${output || "(no output file)"}; delete this part when you fill in the lesson:`,
					output ? firstLines(req.root, output, 40) : "(no output file was recorded)",
					"",
				].join("\n");
				try {
					writeFileSync(join(dir, `${id}.md`), text, { flag: "wx" });
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code === "EEXIST" && n < 1000) continue;
					throw e;
				}
				written.push(`${rel}/${id}.md`);
				known.add(`${name}\0${signature}`);
				break;
			}
		} catch (e) {
			problems.push(`cannot write a lesson draft for ${name} in ${dir}: ${(e as Error).message}`);
		}
	}
	return { written, problems };
}

/** "<procedure>\0<signature>" of each readable draft that has a signature. */
function existingDrafts(dir: string): Set<string> {
	const keys = new Set<string>();
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return keys; // Missing or unreadable: writing the draft reports any real problem.
	}
	for (const file of files) {
		try {
			const { fields } = parseHeader(readFileSync(join(dir, file), "utf8"));
			const tools = fields.get("tools");
			const signature = fields.get("signature");
			if (Array.isArray(tools) && typeof signature === "string" && signature !== "") for (const t of tools) keys.add(`${t}\0${signature}`);
		} catch {
			// A draft a person is editing may not parse; it only means no duplicate check against it.
		}
	}
	return keys;
}
