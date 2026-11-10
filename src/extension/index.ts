// pi extension entry point. A thin adapter: behavior lives in src/core/, which imports nothing from pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Clock } from "../core/clock.ts";
import { registerBudget } from "./budget.ts";
import { registerCompletion } from "./completion.ts";
import { registerInterruptions } from "./interruptions.ts";
import { registerLogging } from "./logging.ts";
import { registerProcedures } from "./procedures.ts";
import { registerProposals } from "./proposals.ts";
import { newState } from "./state.ts";
import { registerSteps } from "./steps.ts";

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
	// Logging first: its session_start handler finds the project root that the others use.
	registerLogging(pi, state, options.clock);
	const steps = registerSteps(pi, state, options.clock);
	// Before completion: its tool_call handler refuses calls after a stop, ahead of the guard.
	const budget = registerBudget(pi, state, steps, options.clock);
	registerCompletion(pi, state, steps, budget, options.clock);
	registerInterruptions(pi, state);
	registerProcedures(pi, state, options.clock);
	registerProposals(pi, state, steps);

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
