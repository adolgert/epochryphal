// Level 1: the requires tracker of plan Section 7.3.
import { describe, expect, it } from "vitest";
import { RequiresTracker, trackerFromEvents } from "../../src/core/requires.ts";

const script = (name: string, ok: boolean | null, outcome = "result") => ({ type: "script", name, outcome, ok });
const edit = (tool = "edit", duration_ms: number | null = 5, parent: string | null = null) => ({ type: "tool_call", tool, duration_ms, is_error: false, parent });

describe("requires tracker", () => {
	it("allows run_sample after a successful build, refuses it after a later edit, and allows it again after another build", () => {
		const t = new RequiresTracker();
		expect(t.missing(["build"])).toEqual(["build"]);
		t.apply(script("build", true));
		expect(t.missing(["build"])).toEqual([]);
		t.apply(edit());
		expect(t.missing(["build"])).toEqual(["build"]);
		t.apply(script("build", true));
		expect(t.missing(["build"])).toEqual([]);
	});

	it("a write clears it too, and so does an edit made by another tool (nested)", () => {
		const t = new RequiresTracker();
		t.apply(script("build", true));
		t.apply(edit("write"));
		expect(t.missing(["build"])).toEqual(["build"]);
		t.apply(script("build", true));
		t.apply(edit("edit", 3, "parent-call"));
		expect(t.missing(["build"])).toEqual(["build"]);
	});

	it("an edit that ran counts even with an error; one that did not run (blocked) does not", () => {
		const t = new RequiresTracker();
		t.apply(script("build", true));
		t.apply({ ...edit("edit", null), is_error: true }); // Blocked by the guard: no duration.
		expect(t.missing(["build"])).toEqual([]);
		t.apply({ ...edit("edit", 2), is_error: true }); // Ran and failed: the file may have been written.
		expect(t.missing(["build"])).toEqual(["build"]);
	});

	it("other tools, such as bash or read, do not count as edits", () => {
		const t = new RequiresTracker();
		t.apply(script("build", true));
		t.apply(edit("bash"));
		t.apply(edit("read"));
		expect(t.missing(["build"])).toEqual([]);
	});

	it("the latest run decides: a failed, broken, or aborted build after a success leaves build missing", () => {
		for (const later of [script("build", false), script("build", null, "script_error"), script("build", null, "aborted")]) {
			const t = new RequiresTracker();
			t.apply(script("build", true));
			t.apply(later);
			expect(t.missing(["build"])).toEqual(["build"]);
		}
	});

	it("reports every missing procedure, in the order required", () => {
		const t = new RequiresTracker();
		t.apply(script("stage", true));
		expect(t.missing(["build", "stage", "configure"])).toEqual(["build", "configure"]);
	});

	it("rebuilds the same state from event-log records", () => {
		const log = [
			{ type: "step_start" },
			script("build", true),
			{ type: "tool_call", tool: "build", duration_ms: 9 },
			script("configure", true),
			edit(),
			script("build", true),
		];
		expect(trackerFromEvents(log).missing(["build", "configure"])).toEqual(["configure"]);
	});
});
