// Interruptions (plan Section 7.6): a message the person sends or an abort the person triggers while
// a step is active, and /why, which labels the latest one.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CommandError } from "../core/commands.ts";
import { type InterruptionHow, readEvents, summarize } from "../core/log.ts";
import { attemptEvents, INTERRUPTION_REASONS, interruptionsOf } from "../core/steps.ts";
import { type HarnessState, say } from "./state.ts";
import { registerHarnessCommand } from "./steps.ts";

const REASONS = INTERRUPTION_REASONS;

export function registerInterruptions(pi: ExtensionAPI, state: HarnessState): void {
	pi.on("input", async (event, ctx) => {
		state.ctx = ctx;
		// The harness's own messages, such as the step prompt, are not interruptions.
		if (!state.step || event.source === "extension") return;
		// The headless runner steers with source "rpc" (docs/pi-facts.md, change 8).
		let how: InterruptionHow;
		if (event.source === "rpc" && ctx.mode !== "rpc") how = "control";
		else if (event.streamingBehavior === "steer") how = "steer";
		else if (event.streamingBehavior === "followUp") how = "follow_up";
		else how = "idle_message";
		state.log?.write("interruption", { how, text_head: summarize(event.text), reason: null, note: null, label_of: null });
	});

	pi.on("agent_settled", async (event, ctx) => {
		state.ctx = ctx;
		const own = state.ownAbort;
		state.ownAbort = false;
		if (event.aborted && !own && state.step) {
			state.log?.write("interruption", { how: "abort", text_head: null, reason: null, note: null, label_of: null });
		}
	});

	registerHarnessCommand(pi, state, "why", `Label the latest interruption of the active step: /why <${REASONS.join("|")}> [note]`, (args) => {
		const [reason = "", ...rest] = args.trim().split(/\s+/);
		const note = rest.join(" ");
		if (reason === "") throw new CommandError(`usage: /why <${REASONS.join("|")}> [note]`);
		if (!REASONS.includes(reason)) throw new CommandError(`the reason must be one of ${REASONS.join(", ")}`);
		const step = state.step;
		if (!step || !state.log) throw new CommandError("no step is active; /why labels interruptions of the active step");
		const latest = interruptionsOf(attemptEvents(readEvents(state.log.path), step)).at(-1);
		if (!latest) throw new CommandError(`step ${step.step} has no interruption to label`);
		state.log.write("interruption", { how: latest.how as InterruptionHow, text_head: null, reason, note: note || null, label_of: latest.n });
		say(state, `Interruption ${latest.n} of step ${step.step} (${latest.how}) labeled ${reason}.`);
	});
}
