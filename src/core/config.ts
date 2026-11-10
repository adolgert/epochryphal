// Load and validate harness/harness.json (plan Section 5.1). Every mistake gets its own message,
// naming the field by its path, and all mistakes are reported together.
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type RuleAction = "warn" | "stop";
export type ParamType = "string" | "number" | "integer" | "boolean";

export interface Budget {
	tokens: number;
	cost_usd: number;
	agent_minutes: number;
	check_attempts: number;
}

export interface KindConfig {
	description: string;
	check: string[];
	check_timeout_s: number;
	budget: Budget;
}

export interface ParamSpec {
	type: ParamType;
	description?: string;
	enum?: string[];
}

export interface ProcedureConfig {
	name: string;
	description: string;
	command: string[];
	params: Record<string, ParamSpec>;
	timeout_s: number;
	is_wait: boolean;
	requires: string[];
	lesson_trigger: boolean;
}

export interface HarnessConfig {
	version: 1;
	max_summary_chars: number;
	protected: string[];
	kinds: Record<string, KindConfig>;
	procedures: ProcedureConfig[];
	rules: { supervised: RuleAction; run_plan: RuleAction; headless: RuleAction; max_iterations: number };
	run_plan: { approve: "ask" | "auto" };
	headless: { session_mode: "fresh_per_step" | "continue" };
	lessons: { max_per_result: number; max_chars: number };
}

export class ConfigError extends Error {
	readonly source: string;
	readonly problems: string[];
	constructor(source: string, problems: string[]) {
		const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
		super(`${source}: ${count}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
		this.name = "ConfigError";
		this.source = source;
		this.problems = problems;
	}
}

/**
 * Tools the harness itself registers; a procedure may not take these names. Clashes with pi's
 * own tools and other extensions' tools are checked at registration, against pi's live tool list.
 */
export const HARNESS_TOOL_NAMES = ["submit", "report_blocked", "propose_step", "harness_ping"];

const KIND_NAME = /^[a-z][a-z0-9_-]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Collects problems while reading fields of an untrusted object. */
class Reader {
	readonly problems: string[] = [];

	/** Read an object's fields; report fields outside `known`. Returns {} when not an object. */
	object(value: unknown, path: string, known: string[]): Obj {
		if (!isObj(value)) {
			this.problems.push(`${path} must be an object`);
			return {};
		}
		for (const key of Object.keys(value)) {
			if (!known.includes(key)) this.problems.push(`unknown field ${path ? `${path}.` : ""}${key}`);
		}
		return value;
	}

	field<T>(obj: Obj, key: string, path: string, check: (v: unknown, p: string) => T | undefined, fallback?: T): T {
		const p = path ? `${path}.${key}` : key;
		if (obj[key] === undefined) {
			if (fallback !== undefined) return fallback;
			this.problems.push(`${p} is required`);
			return undefined as T;
		}
		return check(obj[key], p) as T;
	}

	string = (v: unknown, p: string) => (typeof v === "string" ? v : this.fail(p, "must be a string"));
	boolean = (v: unknown, p: string) => (typeof v === "boolean" ? v : this.fail(p, "must be true or false"));
	positive = (v: unknown, p: string) => (typeof v === "number" && v > 0 ? v : this.fail(p, "must be a positive number"));
	count = (v: unknown, p: string) =>
		typeof v === "number" && Number.isInteger(v) && v > 0 ? v : this.fail(p, "must be a positive whole number");
	strings = (v: unknown, p: string) =>
		Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : this.fail(p, "must be a list of strings");
	command = (v: unknown, p: string) =>
		Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s !== "")
			? (v as string[])
			: this.fail(p, "must be a non-empty list of strings");
	oneOf =
		<T extends string>(...allowed: T[]) =>
		(v: unknown, p: string) =>
			allowed.includes(v as T) ? (v as T) : this.fail(p, `must be one of ${allowed.join(", ")}`);

	fail(path: string, message: string): undefined {
		this.problems.push(`${path} ${message}`);
		return undefined;
	}
}

function readBudget(r: Reader, value: unknown, path: string): Budget {
	const b = r.object(value, path, ["tokens", "cost_usd", "agent_minutes", "check_attempts"]);
	return {
		tokens: r.field(b, "tokens", path, r.positive),
		cost_usd: r.field(b, "cost_usd", path, r.positive),
		agent_minutes: r.field(b, "agent_minutes", path, r.positive),
		check_attempts: r.field(b, "check_attempts", path, r.count),
	};
}

function readKind(r: Reader, value: unknown, path: string): KindConfig {
	const k = r.object(value, path, ["description", "check", "check_timeout_s", "budget"]);
	return {
		description: r.field(k, "description", path, r.string),
		check: r.field(k, "check", path, r.command),
		check_timeout_s: r.field(k, "check_timeout_s", path, r.positive),
		budget: r.field(k, "budget", path, (v, p) => readBudget(r, v, p)),
	};
}

function readParam(r: Reader, value: unknown, path: string): ParamSpec {
	const s = r.object(value, path, ["type", "description", "enum"]);
	const type = r.field(s, "type", path, r.oneOf<ParamType>("string", "number", "integer", "boolean"));
	const spec: ParamSpec = { type };
	if (s.description !== undefined) spec.description = r.field(s, "description", path, r.string);
	if (s.enum !== undefined) {
		if (type !== undefined && type !== "string") r.fail(`${path}.enum`, "is allowed only for string parameters");
		else spec.enum = r.field(s, "enum", path, r.strings);
	}
	return spec;
}

function readProcedure(r: Reader, value: unknown, path: string): ProcedureConfig {
	const known = ["name", "description", "command", "params", "timeout_s", "is_wait", "requires", "lesson_trigger"];
	const o = r.object(value, path, known);
	const name = r.field(o, "name", path, r.string);
	if (typeof name === "string") {
		if (!TOOL_NAME.test(name)) {
			r.fail(`${path}.name`, `"${name}" must use only lowercase letters, digits and "_", starting with a letter`);
		} else if (HARNESS_TOOL_NAMES.includes(name)) {
			r.fail(`${path}.name`, `"${name}" is reserved for a harness tool`);
		}
	}
	const paramsObj = r.field(o, "params", path, (v, p) => r.object(v, p, Object.keys(isObj(v) ? v : {})), {});
	const params: Record<string, ParamSpec> = {};
	for (const [key, spec] of Object.entries(paramsObj)) params[key] = readParam(r, spec, `${path}.params.${key}`);
	return {
		name,
		description: r.field(o, "description", path, r.string),
		command: r.field(o, "command", path, r.command),
		params,
		timeout_s: r.field(o, "timeout_s", path, r.positive),
		is_wait: r.field(o, "is_wait", path, r.boolean, false),
		requires: r.field(o, "requires", path, r.strings, []),
		lesson_trigger: r.field(o, "lesson_trigger", path, r.boolean, false),
	};
}

/** Each cycle in the requires graph once, as a path that starts and ends at the same procedure. */
function requiresCycles(procedures: ProcedureConfig[]): string[][] {
	const requires = new Map<string, string[]>();
	for (const p of procedures) if (typeof p.name === "string" && !requires.has(p.name)) requires.set(p.name, p.requires ?? []);
	const cycles: string[][] = [];
	const seen = new Set<string>();
	const done = new Set<string>();
	const visit = (name: string, path: string[]) => {
		const at = path.indexOf(name);
		if (at >= 0) {
			const cycle = [...path.slice(at), name];
			const key = [...new Set(cycle)].sort().join(" ");
			if (!seen.has(key)) {
				seen.add(key);
				cycles.push(cycle);
			}
			return;
		}
		if (done.has(name) || !requires.has(name)) return;
		for (const next of requires.get(name)!) visit(next, [...path, name]);
		done.add(name);
	};
	for (const name of requires.keys()) visit(name, []);
	return cycles;
}

/** Problems with the executables that commands name. Only paths containing "/" are checked. */
function commandProblems(projectDir: string, config: HarnessConfig): string[] {
	const commands: [string, string[]][] = [
		...Object.entries(config.kinds).map(([name, k]): [string, string[]] => [`kinds.${name}.check`, k.check]),
		...config.procedures.map((p, i): [string, string[]] => [`procedures[${i}].command`, p.command]),
	];
	const problems: string[] = [];
	for (const [path, [program]] of commands) {
		if (program === undefined || !program.includes("/")) continue;
		const abs = resolve(projectDir, program);
		if (!existsSync(abs)) problems.push(`${path}: ${program} does not exist`);
		else {
			try {
				accessSync(abs, constants.X_OK);
			} catch {
				problems.push(`${path}: ${program} is not executable`);
			}
		}
	}
	return problems;
}

/** Check a parsed configuration and fill in defaults. Throws ConfigError listing every problem. */
export function validateConfig(value: unknown, source = "harness.json"): HarnessConfig {
	if (!isObj(value)) throw new ConfigError(source, ["the configuration must be a JSON object"]);
	const r = new Reader();
	const top = ["version", "max_summary_chars", "protected", "kinds", "procedures", "rules", "run_plan", "headless", "lessons"];
	const c = r.object(value, "", top);

	if (c.version !== 1) r.problems.push("version must be 1");

	const kinds: Record<string, KindConfig> = {};
	const kindsObj = r.field(c, "kinds", "", (v, p) => r.object(v, p, Object.keys(isObj(v) ? v : {})));
	if (kindsObj !== undefined && Object.keys(kindsObj).length === 0 && isObj(c.kinds)) {
		r.problems.push("kinds must define at least one kind");
	}
	for (const [name, kind] of Object.entries(kindsObj ?? {})) {
		if (!KIND_NAME.test(name)) {
			r.problems.push(`kind name "${name}" must use only lowercase letters, digits, "-" and "_", starting with a letter`);
		}
		kinds[name] = readKind(r, kind, `kinds.${name}`);
	}

	const procList = r.field(c, "procedures", "", (v, p) => (Array.isArray(v) ? v : r.fail(p, "must be a list")), []);
	const procedures = (procList ?? []).map((p, i) => readProcedure(r, p, `procedures[${i}]`));
	const firstIndex = new Map<string, number>();
	procedures.forEach((p, i) => {
		if (typeof p.name !== "string") return;
		const earlier = firstIndex.get(p.name);
		if (earlier !== undefined) r.problems.push(`procedures[${i}].name "${p.name}" is already used by procedures[${earlier}]`);
		else firstIndex.set(p.name, i);
	});
	procedures.forEach((p, i) => {
		for (const req of p.requires ?? []) {
			if (!firstIndex.has(req)) r.problems.push(`procedures[${i}].requires names "${req}", which is not a procedure`);
		}
	});
	for (const cycle of requiresCycles(procedures)) r.problems.push(`procedures form a requires cycle: ${cycle.join(" -> ")}`);

	const action = r.oneOf<RuleAction>("warn", "stop");
	const rulesObj = r.field(c, "rules", "", (v, p) => r.object(v, p, ["supervised", "run_plan", "headless", "max_iterations"]), {});
	const runPlanObj = r.field(c, "run_plan", "", (v, p) => r.object(v, p, ["approve"]), {});
	const headlessObj = r.field(c, "headless", "", (v, p) => r.object(v, p, ["session_mode"]), {});
	const lessonsObj = r.field(c, "lessons", "", (v, p) => r.object(v, p, ["max_per_result", "max_chars"]), {});

	const config: HarnessConfig = {
		version: 1,
		max_summary_chars: r.field(c, "max_summary_chars", "", r.count, 2000),
		protected: r.field(c, "protected", "", r.strings, []),
		kinds,
		procedures,
		rules: {
			supervised: r.field(rulesObj, "supervised", "rules", action, "warn"),
			run_plan: r.field(rulesObj, "run_plan", "rules", action, "stop"),
			headless: r.field(rulesObj, "headless", "rules", action, "stop"),
			max_iterations: r.field(rulesObj, "max_iterations", "rules", r.count, 3),
		},
		run_plan: { approve: r.field(runPlanObj, "approve", "run_plan", r.oneOf("ask", "auto"), "ask") },
		headless: {
			session_mode: r.field(headlessObj, "session_mode", "headless", r.oneOf("fresh_per_step", "continue"), "fresh_per_step"),
		},
		lessons: {
			max_per_result: r.field(lessonsObj, "max_per_result", "lessons", r.count, 2),
			max_chars: r.field(lessonsObj, "max_chars", "lessons", r.count, 1500),
		},
	};
	if (r.problems.length > 0) throw new ConfigError(source, r.problems);
	return config;
}

/** Read `<projectDir>/<harnessDir>/harness.json`, validate it, and check that its script paths are executable. */
export function loadConfig(projectDir: string, harnessDir = "harness"): HarnessConfig {
	const source = join(harnessDir, "harness.json");
	const path = join(projectDir, source);
	if (!existsSync(path)) throw new ConfigError(source, [`${path} not found`]);
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new ConfigError(source, [`${source} is not valid JSON: ${(e as Error).message}`]);
	}
	const config = validateConfig(value, source);
	const problems = commandProblems(projectDir, config);
	if (problems.length > 0) throw new ConfigError(source, problems);
	return config;
}
