// Level 1: the toy project that every higher-level test runs in.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

describe("makeToyProject", () => {
	it("creates a git repository with exactly one commit and a clean working tree", () => {
		toy = makeToyProject();
		expect(git(toy.dir, "rev-list", "--count", "HEAD")).toBe("1");
		expect(git(toy.dir, "status", "--porcelain")).toBe("");
	});

	it("contains two small source files", () => {
		toy = makeToyProject();
		const tracked = git(toy.dir, "ls-files").split("\n");
		expect(tracked.filter((f) => f.startsWith("src/"))).toHaveLength(2);
	});

	it("writes a harness.json whose kinds and procedures point at executable scripts", () => {
		toy = makeToyProject();
		const config = JSON.parse(readFileSync(join(toy.dir, "harness/harness.json"), "utf8"));
		expect(config.version).toBe(1);
		expect(Object.keys(config.kinds).sort()).toEqual(["measure", "offload", "restructure"]);
		expect(config.procedures.map((p: { name: string }) => p.name)).toEqual(["build", "run_sample", "wait_for_job"]);
		const commands: string[][] = [
			...Object.values(config.kinds).map((k) => (k as { check: string[] }).check),
			...config.procedures.map((p: { command: string[] }) => p.command),
		];
		for (const command of commands) {
			const path = join(toy.dir, command[0]!);
			expect(existsSync(path), path).toBe(true);
			expect(statSync(path).mode & 0o111, path).not.toBe(0);
		}
	});

	it("ignores harness/log/ in git", () => {
		toy = makeToyProject();
		expect(git(toy.dir, "check-ignore", "harness/log/events.jsonl")).toBe("harness/log/events.jsonl");
	});

	it("keeps the fake script's state outside the project directory", () => {
		toy = makeToyProject();
		expect(toy.fakeDir.startsWith(toy.dir)).toBe(false);
	});

	it("accepts overrides to the configuration", () => {
		toy = makeToyProject({ config: { max_summary_chars: 100 } });
		const config = JSON.parse(readFileSync(join(toy.dir, "harness/harness.json"), "utf8"));
		expect(config.max_summary_chars).toBe(100);
	});

	it("removes everything on cleanup", () => {
		toy = makeToyProject();
		const root = toy.root;
		toy.cleanup();
		toy = undefined;
		expect(existsSync(root)).toBe(false);
	});
});
