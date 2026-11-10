// Level 1: glob matching, the guard's decision, and the protected-file check with git.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedProtected, currentCommit, GitError, globToRegExp, guardReason, projectPath, treeFingerprint } from "../../src/core/protect.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => {
	toy?.cleanup();
	toy = undefined;
});

const PATTERNS = ["harness/harness.json", "harness/scripts/**", "tests/**"];
const commit = (t: ToyProject, message: string) => {
	t.git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A");
	t.git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message);
};

describe("glob patterns", () => {
	const cases: [string, string, boolean][] = [
		["tests/**", "tests/a.txt", true],
		["tests/**", "tests/deep/er/a.txt", true],
		["tests/**", "tests", false],
		["tests/**", "src/tests/a.txt", false],
		["harness/harness.json", "harness/harness.json", true],
		["harness/harness.json", "harness/harness.json.bak", false],
		["*.txt", "a.txt", true],
		["*.txt", "src/a.txt", false],
		["src/*.f90", "src/a.f90", true],
		["src/*.f90", "src/sub/a.f90", false],
		["**/*.f90", "a.f90", true],
		["**/*.f90", "src/sub/a.f90", true],
		["src/**/test_*.txt", "src/test_a.txt", true],
		["src/**/test_*.txt", "src/x/y/test_a.txt", true],
		["file?.txt", "file1.txt", true],
		["file?.txt", "file10.txt", false],
		["file?.txt", "file/.txt", false],
		["*", ".hidden", true],
		["a+b(c).txt", "a+b(c).txt", true],
		["a.txt", "abtxt", false],
	];
	for (const [pattern, path, expected] of cases) {
		it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
			expect(globToRegExp(pattern).test(path)).toBe(expected);
		});
	}
});

describe("guard decision", () => {
	it("blocks protected patterns, plan files, and the log; allows other files", () => {
		expect(guardReason("tests/a.txt", PATTERNS, "harness")).toMatch(/protected pattern tests\/\*\*/);
		expect(guardReason("harness/plans/e1.json", PATTERNS, "harness")).toMatch(/plan files/);
		expect(guardReason("harness/plans/ACTIVE", [], "harness")).toMatch(/plan files/);
		expect(guardReason("harness/log/events.jsonl", [], "harness")).toMatch(/log/);
		expect(guardReason("src/solver.txt", PATTERNS, "harness")).toBeNull();
		expect(guardReason("harness/notes.md", PATTERNS, "harness")).toBeNull();
	});

	it("lets the agent's edit tools write lesson drafts, but not approved lessons", () => {
		const patterns = [...PATTERNS, "harness/lessons/**"];
		expect(guardReason("harness/lessons/drafts/e1-s1-a1-build-1.md", patterns, "harness")).toBeNull();
		expect(guardReason("harness/lessons/nvfortran.md", patterns, "harness")).toMatch(/protected pattern harness\/lessons\/\*\*/);
		expect(guardReason("harness/lessons/drafts", patterns, "harness")).toMatch(/protected pattern/);
		expect(guardReason("h2/lessons/drafts/x.md", ["h2/**"], "h2")).toBeNull();
	});

	it("resolves a tool's path against the working directory, strips a leading @, and ignores paths outside the root", () => {
		expect(projectPath("/p", "/p", "tests/a.txt")).toBe("tests/a.txt");
		expect(projectPath("/p", "/p/src", "../tests/a.txt")).toBe("tests/a.txt");
		expect(projectPath("/p", "/p", "@tests/a.txt")).toBe("tests/a.txt");
		expect(projectPath("/p", "/p", "/p/tests/./a.txt")).toBe("tests/a.txt");
		expect(projectPath("/p", "/p", "/elsewhere/a.txt")).toBeNull();
		expect(projectPath("/p", "/p", "..")).toBeNull();
		expect(projectPath("/p", "/p", "/p")).toBeNull();
	});
});

describe("protected-file check with git", () => {
	it("reports a modified tracked file", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		writeFileSync(join(toy.dir, "tests/test_solver.txt"), "expect nothing\n");
		expect(changedProtected(toy.dir, base, PATTERNS, "harness")).toEqual(["tests/test_solver.txt"]);
	});

	it("reports a new untracked file, but not an ignored one", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		mkdirSync(join(toy.dir, "tests/new"));
		writeFileSync(join(toy.dir, "tests/new/test_extra.txt"), "x\n");
		writeFileSync(join(toy.dir, ".gitignore"), "harness/log/\ntests/*.tmp\n");
		writeFileSync(join(toy.dir, "tests/scratch.tmp"), "x\n");
		expect(changedProtected(toy.dir, base, PATTERNS, "harness")).toEqual(["tests/new/test_extra.txt"]);
	});

	it("reports a file changed and then committed", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		writeFileSync(join(toy.dir, "tests/test_solver.txt"), "expect nothing\n");
		commit(toy, "weaken the test");
		expect(changedProtected(toy.dir, base, PATTERNS, "harness")).toEqual(["tests/test_solver.txt"]);
		expect(changedProtected(toy.dir, currentCommit(toy.dir), PATTERNS, "harness")).toEqual([]);
	});

	it("reports a deleted file and a file moved out of a protected directory", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		toy.git("mv", "tests/test_solver.txt", "src/moved.txt");
		rmSync(join(toy.dir, "harness/harness.json"));
		expect(changedProtected(toy.dir, base, PATTERNS, "harness")).toEqual(["harness/harness.json", "tests/test_solver.txt"]);
	});

	it("reports nothing for a changed unprotected file", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		writeFileSync(join(toy.dir, "src/solver.txt"), "changed\n");
		writeFileSync(join(toy.dir, "src/new.txt"), "new\n");
		commit(toy, "work");
		writeFileSync(join(toy.dir, "src/driver.txt"), "changed\n");
		expect(changedProtected(toy.dir, base, PATTERNS, "harness")).toEqual([]);
	});

	it("gives paths relative to a project root below the top of the repository", () => {
		toy = makeToyProject();
		const sub = join(toy.dir, "src");
		mkdirSync(join(sub, "tests"));
		writeFileSync(join(sub, "tests/t.txt"), "x\n");
		commit(toy, "nested");
		const base = currentCommit(sub);
		writeFileSync(join(sub, "tests/t.txt"), "y\n");
		writeFileSync(join(toy.dir, "tests/test_solver.txt"), "outside the root\n");
		expect(changedProtected(sub, base, ["tests/**"], "harness")).toEqual(["tests/t.txt"]);
	});

	it("leaves out lesson drafts, untracked, committed, or changed, but not an approved lesson", () => {
		toy = makeToyProject();
		const patterns = [...PATTERNS, "harness/lessons/**"];
		const base = currentCommit(toy.dir);
		mkdirSync(join(toy.dir, "harness/lessons/drafts"), { recursive: true });
		writeFileSync(join(toy.dir, "harness/lessons/drafts/d1.md"), "draft\n");
		expect(changedProtected(toy.dir, base, patterns, "harness")).toEqual([]);
		commit(toy, "keep the draft");
		writeFileSync(join(toy.dir, "harness/lessons/drafts/d1.md"), "draft, edited\n");
		expect(changedProtected(toy.dir, base, patterns, "harness")).toEqual([]);
		// Moved into lessons/: the approved lesson counts until it is committed.
		toy.git("mv", "harness/lessons/drafts/d1.md", "harness/lessons/l1.md");
		expect(changedProtected(toy.dir, currentCommit(toy.dir), patterns, "harness")).toEqual(["harness/lessons/l1.md"]);
	});

	it("leaves lesson drafts out of the working-tree fingerprint", () => {
		toy = makeToyProject();
		const base = currentCommit(toy.dir);
		const first = treeFingerprint(toy.dir, base, "harness");
		mkdirSync(join(toy.dir, "harness/lessons/drafts"), { recursive: true });
		writeFileSync(join(toy.dir, "harness/lessons/drafts/d1.md"), "draft\n");
		expect(treeFingerprint(toy.dir, base, "harness")).toBe(first);
		writeFileSync(join(toy.dir, "harness/lessons/l1.md"), "lesson\n");
		expect(treeFingerprint(toy.dir, base, "harness")).not.toBe(first);
	});

	it("refuses with a GitError outside a git repository, and in a repository with no commit", () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-nogit-"));
		try {
			expect(() => currentCommit(dir)).toThrow(GitError);
			expect(() => currentCommit(dir)).toThrow(/needs the project to be a git repository with at least one commit/);
			expect(() => changedProtected(dir, "HEAD", PATTERNS, "harness")).toThrow(GitError);
			toy = makeToyProject();
			rmSync(join(toy.dir, ".git"), { recursive: true });
			toy.git("init", "-q");
			expect(() => currentCommit(toy!.dir)).toThrow(/at least one commit/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses with a GitError when git is not installed", () => {
		toy = makeToyProject();
		const path = process.env.PATH;
		process.env.PATH = join(toy.workDir, "empty");
		try {
			expect(() => currentCommit(toy!.dir)).toThrow(/git is not installed or not on the PATH/);
		} finally {
			process.env.PATH = path;
		}
	});

	it("refuses with a GitError when the base commit does not exist", () => {
		toy = makeToyProject();
		expect(() => changedProtected(toy!.dir, "0123456789abcdef0123456789abcdef01234567", PATTERNS, "harness")).toThrow(GitError);
	});
});
