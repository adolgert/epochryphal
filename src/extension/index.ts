// pi extension entry point. A thin adapter: behavior lives in src/core/, which imports nothing from pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function harness(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "harness_ping",
		label: "Harness ping",
		description: "Check that the harness extension is loaded. Returns the text 'pong'.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "pong" }], details: undefined };
		},
	});
}
