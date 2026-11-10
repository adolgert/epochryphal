// Level 1: finding the project root from pi's working directory.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectRoot } from "../../src/core/project.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "harness-root-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harnessAt(path: string, harnessDir = "harness"): void {
	mkdirSync(join(path, harnessDir), { recursive: true });
	writeFileSync(join(path, harnessDir, "harness.json"), "{}");
}

describe("findProjectRoot", () => {
	it("returns the directory itself when it holds harness/harness.json", () => {
		harnessAt(dir);
		expect(findProjectRoot(dir)).toBe(dir);
	});

	it("walks up from a subdirectory", () => {
		harnessAt(dir);
		mkdirSync(join(dir, "src/deep"), { recursive: true });
		expect(findProjectRoot(join(dir, "src/deep"))).toBe(dir);
	});

	it("chooses the nearest root when projects are nested", () => {
		harnessAt(dir);
		harnessAt(join(dir, "vendor/other"));
		mkdirSync(join(dir, "vendor/other/src"), { recursive: true });
		expect(findProjectRoot(join(dir, "vendor/other/src"))).toBe(join(dir, "vendor/other"));
	});

	it("ignores a harness directory without harness.json", () => {
		mkdirSync(join(dir, "inner/harness"), { recursive: true });
		harnessAt(dir);
		expect(findProjectRoot(join(dir, "inner"))).toBe(dir);
	});

	it("uses the configured harness directory name", () => {
		harnessAt(dir, "porting");
		expect(findProjectRoot(dir, "porting")).toBe(dir);
		expect(findProjectRoot(dir)).toBeNull();
	});

	it("returns null when no directory up to the filesystem root has one", () => {
		expect(findProjectRoot(dir)).toBeNull();
	});
});
