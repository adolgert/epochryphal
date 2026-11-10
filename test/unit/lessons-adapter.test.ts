// Level 1 (stub): the lessons adapter. Load-time messages, and which tool results get lessons.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessExtension } from "../../src/extension/index.ts";
import { FakeClock } from "../rig/clock.ts";
import { FakePi } from "../rig/fake-pi.ts";
import { type Behavior, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

const LESSON = (id: string, pattern: string) => `---\nid: ${id}\npattern: ${pattern}\ntools: [build]\n---\nWorkaround for ${id}.\n`;

async function start(behavior: Behavior, lessons: Record<string, string> | null) {
	toy = makeToyProject({ behavior });
	if (lessons) {
		mkdirSync(join(toy.dir, "harness/lessons"), { recursive: true });
		for (const [file, text] of Object.entries(lessons)) writeFileSync(join(toy.dir, "harness/lessons", file), text);
	}
	const pi = new FakePi().load(createHarnessExtension({ clock: new FakeClock() }));
	const opts = { cwd: toy.dir };
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, opts);
	/** Call build as pi would: execute, then the tool_result handlers. Returns their patches. */
	const build = async (id: number) => {
		const r = await pi.callTool("build", { variant: "gpu" }, opts);
		return pi.fire("tool_result", { type: "tool_result", toolCallId: `fake-call-${id}`, toolName: "build", input: {}, content: r.content, isError: r.isError === true, details: undefined }, opts);
	};
	return { pi, build };
}

describe("lessons adapter", () => {
	it("no lessons directory: silent", async () => {
		const { pi } = await start({}, null);
		expect(pi.notifications).toEqual([]);
	});

	it("a lesson with a bad header is skipped with a message naming the file and the problem; the others load", async () => {
		const { pi, build } = await start({ build: [{ ok: false, summary: "E42 failed" }] }, { "a.md": LESSON("good", "E42"), "b.md": LESSON("bad", '"E(42"') });
		expect(pi.notifications).toEqual([
			{ message: expect.stringMatching(/^harness: lesson not loaded: .*harness\/lessons\/b\.md: the pattern is not a valid regular expression: .*The other lessons are loaded\.$/), type: "warning" },
		]);
		const [patch] = await build(1);
		expect(patch).toMatchObject({ content: [{ type: "text", text: "E42 failed" }, { type: "text", text: "\n\n[lesson good]\nWorkaround for good." }] });
	});

	it("only a failed result gets a lesson: not a success, a script error, or a refusal", async () => {
		const { pi, build } = await start({ build: [{ ok: true, summary: "E42 ok" }, { mode: "exit", code: 3 }] }, { "a.md": LESSON("any", ".") });
		expect(await build(1)).toEqual([undefined]);
		expect(await build(2)).toEqual([undefined]);
		const refused = await pi.callTool("run_sample", {}, { cwd: toy!.dir });
		expect(refused.isError).toBe(true);
		expect(await pi.fire("tool_result", { type: "tool_result", toolCallId: "fake-call-3", toolName: "run_sample", input: {}, content: refused.content, isError: true, details: undefined }, { cwd: toy!.dir })).toEqual([undefined]);
		expect(toy!.readEvents().filter((e) => e.type === "lesson_injected")).toEqual([]);
	});
});
