// The scripted model's script format and the record of requests it receives.
// Shared by the in-process helper (sdk-session.ts) and the subprocess helper (cli.ts).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One model response: a tool call, several tool calls, or text. */
export type ScriptEntry =
	| { tool: string; args?: Record<string, unknown> }
	| { tools: { tool: string; args?: Record<string, unknown> }[] }
	| { text: string };

/** One request the scripted model received. */
export interface ModelRequest {
	system: string;
	tools: string[];
	messages: { role: string; content: unknown }[];
}

/** Text the scripted model answers with once the script runs out. */
export const SCRIPT_EXHAUSTED = "SCRIPT_EXHAUSTED";

/** Absolute path of the scripted-model extension. */
export const SCRIPTED_MODEL_PATH = new URL("./scripted-model.ts", import.meta.url).pathname;
export const SCRIPTED_PROVIDER = "scripted";
export const SCRIPTED_MODEL_ID = "scripted-1";

export interface ScriptFiles {
	scriptPath: string;
	requestsPath: string;
}

/** Write a script into `dir` and return the paths the scripted model reads and writes. */
export function writeScript(dir: string, script: ScriptEntry[]): ScriptFiles {
	const scriptPath = join(dir, "script.json");
	const requestsPath = join(dir, "requests.jsonl");
	writeFileSync(scriptPath, JSON.stringify(script, null, 2));
	writeFileSync(requestsPath, "");
	return { scriptPath, requestsPath };
}

export function readRequests(requestsPath: string): ModelRequest[] {
	if (!existsSync(requestsPath)) return [];
	return readFileSync(requestsPath, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as ModelRequest);
}

/**
 * Environment for any process that may run pi under test. Removes provider credentials so that a
 * mistake in model selection fails instead of reaching a real, paid model.
 */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (/API_KEY|TOKEN|SECRET|CREDENTIALS|^AWS_|^AZURE_|^GOOGLE_CLOUD|^VERTEX/.test(key)) continue;
		env[key] = value;
	}
	return env;
}
