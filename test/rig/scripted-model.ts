// Scripted model: a pi extension that registers provider "scripted" with model "scripted-1".
// It replays the script named by HARNESS_TEST_SCRIPT, one entry per model response, and appends
// every request it receives to HARNESS_TEST_REQUESTS. Every response reports the same usage, so
// budget tests are exact. Built on pi-ai's faux provider core (see docs/pi-facts.md, change 1).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createFauxCore,
	createProvider,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type JsonObject,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { appendFileSync, readFileSync } from "node:fs";
import { SCRIPT_EXHAUSTED, SCRIPTED_MODEL_ID, SCRIPTED_PROVIDER, type ScriptEntry } from "./script.ts";

export const SCRIPTED_USAGE: Usage = {
	input: 100,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 110,
	cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 },
};

function toMessage(entry: ScriptEntry): AssistantMessage {
	if ("text" in entry) return fauxAssistantMessage(fauxText(entry.text));
	const calls = "tools" in entry ? entry.tools : [entry];
	return fauxAssistantMessage(
		calls.map((c) => fauxToolCall(c.tool, (c.args ?? {}) as JsonObject)),
		{ stopReason: "toolUse" },
	);
}

export default function scriptedModel(pi: ExtensionAPI): void {
	const scriptPath = process.env.HARNESS_TEST_SCRIPT;
	const requestsPath = process.env.HARNESS_TEST_REQUESTS;
	if (!scriptPath || !requestsPath) {
		throw new Error("scripted-model: HARNESS_TEST_SCRIPT and HARNESS_TEST_REQUESTS must be set");
	}
	const script = JSON.parse(readFileSync(scriptPath, "utf8")) as ScriptEntry[];

	const core = createFauxCore({ api: "harness-scripted", provider: SCRIPTED_PROVIDER, models: [{ id: SCRIPTED_MODEL_ID }] });
	const record = (context: TranscriptContext) => {
		const messages = context.messages
			.filter((m) => m.role !== "system")
			.map((m) => ({ role: m.role, content: "content" in m ? m.content : undefined }));
		const request = {
			system: getCurrentSystemPrompt(context.messages),
			tools: getCurrentTools(context.messages).map((t) => t.name),
			messages,
		};
		appendFileSync(requestsPath, JSON.stringify(request) + "\n");
	};
	// Once the script is used up, keep answering SCRIPT_EXHAUSTED so the test helper can fail the test.
	const exhausted: ScriptEntry = { text: SCRIPT_EXHAUSTED };
	let next = 0;
	const respond = (context: TranscriptContext) => {
		record(context);
		const entry = script[next] ?? exhausted;
		next++;
		return toMessage(entry);
	};
	const pushOne = () => core.appendResponses([respond]);

	// The faux core replaces usage with an estimate; restore the fixed numbers on every event.
	const withUsage = <T>(value: T): T =>
		value && typeof value === "object" && "usage" in value ? { ...value, usage: SCRIPTED_USAGE } : value;
	const stream: typeof core.stream = (model, context, options) => {
		pushOne();
		const inner = core.stream(model, context, options);
		const outer = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of inner) {
				const patched = { ...event } as Record<string, unknown>;
				for (const key of ["partial", "message", "error"]) {
					if (key in patched) patched[key] = withUsage(patched[key]);
				}
				outer.push(patched as typeof event);
			}
			outer.end(withUsage(await inner.result()));
		})();
		return outer;
	};

	pi.registerProvider(
		createProvider({
			id: SCRIPTED_PROVIDER,
			name: "Scripted test model",
			auth: { apiKey: { name: "Scripted", resolve: async () => ({ auth: {} }) } },
			models: core.models,
			api: { stream, streamSimple: stream },
		}),
	);
}
