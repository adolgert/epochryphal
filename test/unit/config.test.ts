// Level 1: loading and validating harness/harness.json (plan Section 5.1).
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, validateConfig } from "../../src/core/config.ts";
import { defaultConfig, makeToyProject, type ToyProject } from "../rig/toy-project.ts";

let toy: ToyProject | undefined;
afterEach(() => toy?.cleanup());

/** The problems validateConfig reports for a config, or [] when it is valid. */
function problems(config: unknown): string[] {
	try {
		validateConfig(config);
		return [];
	} catch (e) {
		if (e instanceof ConfigError) return e.problems;
		throw e;
	}
}

/** The default toy configuration with one change applied. */
function changed(change: (c: any) => void): unknown {
	const c = structuredClone(defaultConfig()) as any;
	change(c);
	return c;
}

const minimal = {
	version: 1,
	kinds: {
		measure: {
			description: "Record a profile.",
			check: ["harness/scripts/check", "measure"],
			check_timeout_s: 60,
			budget: { tokens: 1000, cost_usd: 1, agent_minutes: 10, check_attempts: 3 },
		},
	},
};

describe("loadConfig", () => {
	it("loads the toy project's configuration", () => {
		toy = makeToyProject();
		const config = loadConfig(toy.dir);
		expect(Object.keys(config.kinds)).toEqual(["restructure", "offload", "measure"]);
		expect(config.procedures.map((p) => p.name)).toEqual(["build", "run_sample", "wait_for_job"]);
	});

	it("reads from a differently named harness directory", () => {
		toy = makeToyProject();
		mkdirSync(join(toy.dir, "porting"));
		writeFileSync(join(toy.dir, "porting/harness.json"), JSON.stringify(minimal));
		expect(Object.keys(loadConfig(toy.dir, "porting").kinds)).toEqual(["measure"]);
	});

	it("names the file when it is missing", () => {
		toy = makeToyProject();
		expect(() => loadConfig(toy!.dir, "nowhere")).toThrow(/nowhere\/harness\.json.*not found/);
	});

	it("reports a script path in a command that does not exist or is not executable", () => {
		toy = makeToyProject();
		rmSync(join(toy.dir, "harness/scripts/check"));
		chmodSync(join(toy.dir, "harness/scripts/build"), 0o644);
		expect(() => loadConfig(toy!.dir)).toThrow(ConfigError);
		try {
			loadConfig(toy.dir);
		} catch (e) {
			expect((e as ConfigError).problems).toEqual([
				"kinds.restructure.check: harness/scripts/check does not exist",
				"kinds.offload.check: harness/scripts/check does not exist",
				"kinds.measure.check: harness/scripts/check does not exist",
				"procedures[0].command: harness/scripts/build is not executable",
			]);
		}
	});

	it("does not look up commands without a slash, which are found on PATH when run", () => {
		toy = makeToyProject({ config: { procedures: [{ name: "lint", description: "Lint.", command: ["make", "lint"], timeout_s: 60 }] } });
		expect(loadConfig(toy.dir).procedures[0]!.command).toEqual(["make", "lint"]);
	});

	it("names the file when it is not valid JSON", () => {
		toy = makeToyProject();
		writeFileSync(join(toy.dir, "harness/harness.json"), "{ version: 1, }");
		expect(() => loadConfig(toy!.dir)).toThrow(/harness\/harness\.json.*not valid JSON/);
	});
});

describe("validateConfig", () => {
	it("accepts the full default configuration", () => {
		expect(problems(defaultConfig())).toEqual([]);
	});

	it("fills in defaults for every optional field", () => {
		const config = validateConfig(minimal);
		expect(config).toMatchObject({
			max_summary_chars: 2000,
			protected: [],
			procedures: [],
			rules: { supervised: "warn", run_plan: "stop", headless: "stop", max_iterations: 3 },
			run_plan: { approve: "ask" },
			headless: { session_mode: "fresh_per_step" },
			lessons: { max_per_result: 2, max_chars: 1500 },
		});
	});

	it("fills in defaults for optional procedure fields", () => {
		const config = validateConfig({
			...minimal,
			procedures: [{ name: "build", description: "Build.", command: ["harness/scripts/build"], timeout_s: 60 }],
		});
		expect(config.procedures[0]).toEqual({
			name: "build",
			description: "Build.",
			command: ["harness/scripts/build"],
			timeout_s: 60,
			params: {},
			is_wait: false,
			requires: [],
			lesson_trigger: false,
		});
	});

	it("rejects a value that is not an object", () => {
		expect(problems([])).toEqual(["the configuration must be a JSON object"]);
	});

	it("rejects a version other than 1", () => {
		expect(problems({ ...minimal, version: 2 })).toEqual(["version must be 1"]);
	});

	it("requires at least one kind", () => {
		expect(problems({ version: 1, kinds: {} })).toEqual(["kinds must define at least one kind"]);
	});

	it("reports a kind with no check", () => {
		expect(problems(changed((c) => delete c.kinds.offload.check))).toEqual(["kinds.offload.check is required"]);
	});

	it("reports an empty check command", () => {
		expect(problems(changed((c) => (c.kinds.offload.check = [])))).toEqual([
			"kinds.offload.check must be a non-empty list of strings",
		]);
	});

	it("reports an unknown field at the top level and inside a kind", () => {
		expect(problems(changed((c) => (c.maxsummary = 5)))).toEqual(["unknown field maxsummary"]);
		expect(problems(changed((c) => (c.kinds.offload.chek = ["x"])))).toEqual(["unknown field kinds.offload.chek"]);
	});

	it("reports a budget field of the wrong type", () => {
		expect(problems(changed((c) => (c.kinds.measure.budget.tokens = "lots"))))
			.toEqual(["kinds.measure.budget.tokens must be a positive number"]);
	});

	it("reports a kind name that cannot be typed as a command argument", () => {
		expect(problems(changed((c) => (c.kinds["GPU port"] = c.kinds.offload)))).toEqual([
			'kind name "GPU port" must use only lowercase letters, digits, "-" and "_", starting with a letter',
		]);
	});

	it("still checks the body of a kind whose name is bad", () => {
		const bad = changed((c) => {
			c.kinds["GPU port"] = structuredClone(c.kinds.offload);
			delete c.kinds["GPU port"].check;
		});
		expect(problems(bad)).toEqual([
			'kind name "GPU port" must use only lowercase letters, digits, "-" and "_", starting with a letter',
			'kinds.GPU port.check is required',
		]);
	});

	it("reports a duplicate procedure name", () => {
		expect(problems(changed((c) => (c.procedures[1].name = "build")))).toEqual([
			'procedures[1].name "build" is already used by procedures[0]',
		]);
	});

	it("reports a requires entry that names no procedure", () => {
		expect(problems(changed((c) => (c.procedures[1].requires = ["biuld"])))).toEqual([
			'procedures[1].requires names "biuld", which is not a procedure',
		]);
	});

	it("reports a procedure that requires itself", () => {
		expect(problems(changed((c) => (c.procedures[0].requires = ["build"])))).toEqual([
			"procedures form a requires cycle: build -> build",
		]);
	});

	it("reports a requires cycle through several procedures, once", () => {
		expect(problems(changed((c) => (c.procedures[0].requires = ["run_sample"])))).toEqual([
			"procedures form a requires cycle: build -> run_sample -> build",
		]);
	});

	it("reports a procedure name that is not a valid tool name or that clashes with a tool", () => {
		expect(problems(changed((c) => (c.procedures[0].name = "Build-It")))).toContain(
			'procedures[0].name "Build-It" must use only lowercase letters, digits and "_", starting with a letter',
		);
		expect(problems(changed((c) => (c.procedures[2].name = "submit")))).toEqual([
			'procedures[2].name "submit" is reserved for a harness tool',
		]);
	});

	it("leaves clashes with pi's own tools to tool registration, which sees pi's real tool list", () => {
		expect(problems(changed((c) => (c.procedures[2].name = "read")))).toEqual([]);
	});

	it("reports a parameter with an unknown type, and an enum on a non-string parameter", () => {
		expect(problems(changed((c) => (c.procedures[0].params.variant.type = "text")))).toEqual([
			"procedures[0].params.variant.type must be one of string, number, integer, boolean",
		]);
		expect(problems(changed((c) => (c.procedures[0].params.count = { type: "number", enum: [1, 2] })))).toEqual([
			"procedures[0].params.count.enum is allowed only for string parameters",
		]);
	});

	it("reports a rule action that is neither warn nor stop", () => {
		expect(problems(changed((c) => (c.rules.supervised = "ignore")))).toEqual(["rules.supervised must be one of warn, stop"]);
	});

	it("reports every problem at once, and the error message lists them", () => {
		const bad = changed((c) => {
			delete c.kinds.offload.check;
			c.procedures[1].requires = ["biuld"];
			c.extra = true;
		});
		expect(problems(bad)).toHaveLength(3);
		expect(() => validateConfig(bad)).toThrow(/3 problems.*\n.*\n.*\n/);
	});
});
