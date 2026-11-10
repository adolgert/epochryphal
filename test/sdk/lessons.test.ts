// Level 2: lessons in a real pi session with the scripted model. The first test is the drift test
// for pi's tool_result event.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptEntry } from "../rig/script.ts";
import { runSdkSession, type SdkSession, type SdkSessionOptions } from "../rig/sdk-session.ts";
import { type Behavior, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

const sessions: SdkSession[] = [];
let toy: ToyProject | undefined;
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.dispose();
	toy?.cleanup();
	toy = undefined;
});

const LESSON = `---
id: nvfortran-derived-type
pattern: "NVFORTRAN-S-0155.*derived type"
tools: [build]
compiler: nvfortran 25.9
---
Cause: a derived type with allocatable parts in a target data map.
Workaround: map the components one by one.
`;
const BLOCK = "[lesson nvfortran-derived-type]\nCause: a derived type with allocatable parts in a target data map.\nWorkaround: map the components one by one.";
const FAIL = { ok: false, summary: "NVFORTRAN-S-0155: derived type not allowed in map", signature: "S-0155" };
const build: ScriptEntry = { tool: "build", args: { variant: "gpu" } };

function project(behavior: Behavior, lessons: Record<string, string> = {}): ToyProject {
	toy = makeToyProject({ behavior });
	for (const [file, text] of Object.entries(lessons)) writeLesson(toy, file, text);
	return toy;
}
function writeLesson(t: ToyProject, file: string, text: string): void {
	mkdirSync(join(t.dir, "harness/lessons"), { recursive: true });
	writeFileSync(join(t.dir, "harness/lessons", file), text);
}
async function session(t: ToyProject, script: ScriptEntry[], extra: Partial<SdkSessionOptions> = {}): Promise<SdkSession> {
	const s = await runSdkSession({ project: t, script, ...extra });
	sessions.push(s);
	return s;
}
const ofType = (type: string) => toy!.readEvents().filter((e) => e.type === type);
const drafts = (t: ToyProject) => {
	const dir = join(t.dir, "harness/lessons/drafts");
	return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe("lessons in a real session", () => {
	it("[drift] tool_result: a failing build that matches a lesson ends with the lesson, the model sees it, and lesson_injected is logged", async () => {
		const t = project({ build: [FAIL] }, { "nvfortran.md": LESSON });
		const s = await session(t, [build, { text: "I see the lesson." }]);
		await s.prompt("Build it.");
		expect(s.toolResults()).toEqual([{ toolName: "build", isError: true, text: `${FAIL.summary}\n\n${BLOCK}` }]);
		const shown = s.requests()[1]!.messages.at(-1);
		expect(JSON.stringify(shown)).toContain(JSON.stringify(`\n\n${BLOCK}`));
		expect(ofType("lesson_injected")).toEqual([expect.objectContaining({ lesson_id: "nvfortran-derived-type", tool: "build", step: null })]);
	});

	it("a lesson file added during a session is not used until the next session", async () => {
		const t = project({ build: [FAIL] });
		const first = await session(t, [build, { text: "no lesson" }, build, { text: "still none" }]);
		await first.prompt("Build it.");
		writeLesson(t, "nvfortran.md", LESSON);
		await first.prompt("Build it again.");
		expect(first.toolResults().map((r) => r.text)).toEqual([FAIL.summary, FAIL.summary]);
		expect(ofType("lesson_injected")).toEqual([]);
		const second = await session(t, [build, { text: "now a lesson" }]);
		await second.prompt("Build it.");
		expect(second.toolResults()[0]!.text).toBe(`${FAIL.summary}\n\n${BLOCK}`);
	});

	it("a procedure with lesson_trigger false never receives a lesson", async () => {
		const t = project({ wait_for_job: [FAIL] }, { "wait.md": LESSON.replace("tools: [build]", "tools: [wait_for_job, build]") });
		const s = await session(t, [{ tool: "wait_for_job", args: { job_id: "7" } }, { text: "ok" }]);
		await s.prompt("Wait for the job.");
		expect(s.toolResults()).toEqual([{ toolName: "wait_for_job", isError: true, text: FAIL.summary }]);
		expect(ofType("lesson_injected")).toEqual([]);
	});

	it("two steps in a row: the first passes after a build failure and writes a draft, and the second still starts", async () => {
		const t = project({ build: [FAIL, { ok: true, summary: "built" }] });
		const s = await session(t, [build, build, { tool: "submit" }, { tool: "submit" }]);
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("/step measure -- First");
		const plan = () => (t.readPlan("e1") as { steps: { status: string }[] }).steps.map((x) => x.status);
		expect(plan()).toEqual(["passed"]);
		expect(drafts(t)).toEqual(["e1-s1-a1-build-1.md"]);
		expect(ofType("lesson_drafted")).toEqual([expect.objectContaining({ step: "s1", attempt: 1, path: "harness/lessons/drafts/e1-s1-a1-build-1.md" })]);
		const text = readFileSync(join(t.dir, "harness/lessons/drafts/e1-s1-a1-build-1.md"), "utf8");
		const base = String(ofType("step_start")[0]!.commit).slice(0, 12);
		expect(text).toContain(`evidence: "plan e1 step s1 attempt 1, commits ${base}..${base}"`);
		expect(text).toContain("NVFORTRAN-S-0155: derived type not allowed in map");
		// The draft is an untracked file under the protected harness/lessons/**, and does not block the next step.
		expect(t.git("status", "--porcelain", "--untracked-files=all")).toContain("harness/lessons/drafts/e1-s1-a1-build-1.md");
		await s.prompt("/step measure -- Second");
		expect(plan()).toEqual(["passed", "passed"]);
	});

	it("a draft that cannot be written is reported, and the step still passes", async () => {
		const t = project({ build: [FAIL, { ok: true, summary: "built" }] });
		mkdirSync(join(t.dir, "harness/lessons"), { recursive: true });
		writeFileSync(join(t.dir, "harness/lessons/drafts"), "a file where the directory should be\n");
		t.git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A");
		t.git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "block drafts");
		const s = await session(t, [build, build, { tool: "submit" }], { ui: { select: [] } });
		await s.prompt("/plan-new e1 Goal");
		await s.prompt("/step measure -- First");
		expect((t.readPlan("e1") as { steps: { status: string }[] }).steps[0]!.status).toBe("passed");
		expect(s.toolResults().at(-1)).toMatchObject({ toolName: "submit", isError: false, text: expect.stringContaining("Step s1 passed.") });
		expect(s.notices).toContainEqual(expect.stringMatching(/^harness: cannot write a lesson draft for build in .*: EEXIST.*Step s1 still passed\.$/));
		expect(ofType("lesson_drafted")).toEqual([]);
	});
});
