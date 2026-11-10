// pi extension entry point. A thin adapter: behavior lives in src/core/, which imports nothing from pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Clock } from "../core/clock.ts";
import { registerBudget } from "./budget.ts";
import { registerCompletion } from "./completion.ts";
import { headlessHandle, type RunnerHandle } from "./headless.ts";
import { registerInterruptions } from "./interruptions.ts";
import { type LessonsApi, registerLessons } from "./lessons.ts";
import { registerLogging } from "./logging.ts";
import { registerProcedures } from "./procedures.ts";
import { registerProposals } from "./proposals.ts";
import { registerRunPlan } from "./runplan.ts";
import { newState } from "./state.ts";
import { registerSteps } from "./steps.ts";

export interface HarnessOptions {
	/** Clock for timestamps and durations. Tests pass a fake one. */
	clock?: Clock;
	/** The headless runner sets "headless": events and step records carry it, and rules.headless applies. */
	mode?: "headless";
	/** Called with each event record as it is logged (the runner's live feed). */
	onEvent?: (record: Record<string, unknown>) => void;
	/** Called once, at load, with the handle the headless runner drives this instance through. */
	connect?: (handle: RunnerHandle) => void;
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
	if (options.mode) state.mode = options.mode;
	// Logging first: its session_start handler finds the project root that the others use.
	registerLogging(pi, state, options.clock, options.onEvent);
	let lessons: LessonsApi | undefined;
	const steps = registerSteps(pi, state, options.clock, (step) => lessons?.draft(step));
	// Before completion: its tool_call handler refuses calls after a stop, ahead of the guard.
	const budget = registerBudget(pi, state, steps, options.clock);
	const completion = registerCompletion(pi, state, steps, budget, options.clock);
	registerInterruptions(pi, state);
	const procedures = registerProcedures(pi, state, options.clock);
	lessons = registerLessons(pi, state, procedures, options.clock);
	registerProposals(pi, state, steps);
	registerRunPlan(pi, state, steps);
	options.connect?.(headlessHandle(state, steps, budget, completion));

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
