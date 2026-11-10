// Finding the project root: the nearest directory, at or above the working directory, whose
// harness directory holds harness.json.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findProjectRoot(start: string, harnessDir = "harness"): string | null {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(join(dir, harnessDir, "harness.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
