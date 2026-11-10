// pi extension entry point. A thin adapter: behavior lives in src/core/, which imports nothing from pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Clock } from "../core/clock.ts";
import { registerLogging } from "./logging.ts";
import { newState } from "./state.ts";

export interface HarnessOptions {
	/** Clock for timestamps and durations. Tests pass a fake one. */
	clock?: Clock;
}

/** Build the extension. pi loads the default export; tests call this with options. */
export function createHarnessExtension(options: HarnessOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => harness(pi, options);
}

export default function harnessExtension(pi: ExtensionAPI): void {
	harness(pi, {});
}

function harness(pi: ExtensionAPI, options: HarnessOptions): void {
	const state = newState();
	registerLogging(pi, state, options.clock);

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
