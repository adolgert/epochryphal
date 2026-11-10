// Probe: scripted model as a pi extension, built on pi-ai's faux core.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	createFauxCore,
	createProvider,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import { appendFileSync, readFileSync } from "node:fs";

const USAGE = {
	input: 100,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 110,
	cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 },
};

type Entry = { tool?: string; args?: any; tools?: { tool: string; args?: any }[]; text?: string };

export default function (pi: ExtensionAPI) {
	const scriptPath = process.env.HARNESS_TEST_SCRIPT;
	if (!scriptPath) return;
	const script: Entry[] = JSON.parse(readFileSync(scriptPath, "utf8"));
	const reqPath = process.env.HARNESS_TEST_REQUESTS ?? `${scriptPath}.requests.jsonl`;
	const core = createFauxCore({ api: "harness-scripted", provider: "scripted", models: [{ id: "scripted-1" }] });
	const toMessage = (e: Entry) => {
		if (e.text !== undefined) return fauxAssistantMessage(fauxText(e.text));
		const calls = e.tools ?? [{ tool: e.tool!, args: e.args }];
		return fauxAssistantMessage(calls.map((c) => fauxToolCall(c.tool, c.args ?? {})), { stopReason: "toolUse" });
	};
	const steps = [...script, { text: "SCRIPT_EXHAUSTED" }].map((e) => (context: any) => {
		appendFileSync(
			reqPath,
			JSON.stringify({
				system: getCurrentSystemPrompt(context.messages),
				tools: getCurrentTools(context.messages).map((t) => t.name),
				messages: context.messages.filter((m: any) => m.role !== "system"),
			}) + "\n",
		);
		return toMessage(e);
	});
	core.setResponses(steps);
	const fix = (m: any) => (m && m.usage ? { ...m, usage: USAGE } : m);
	const stream = (model: any, context: any, options: any) => {
		const inner = core.stream(model, context, options);
		const outer = createAssistantMessageEventStream();
		(async () => {
			for await (const ev of inner as any) {
				const patched: any = { ...ev };
				for (const k of ["partial", "message", "error"]) if (k in patched) patched[k] = fix(patched[k]);
				outer.push(patched);
			}
			outer.end(fix(await inner.result()));
		})();
		return outer;
	};
	pi.registerProvider(
		createProvider({
			id: "scripted",
			auth: { apiKey: { name: "Scripted", resolve: async () => ({ auth: {} }) } },
			models: core.models,
			api: { stream, streamSimple: stream } as any,
		}) as any,
	);
}
