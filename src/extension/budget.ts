// Budgets and stop rules (plan Section 7.7). The rules run after each model call and after each
// failed check. "warn" tells the person once per rule per step attempt; "stop" ends the step as
// stopped, blocks the run's further tool calls, and ends the run. The headless-only rules use stop().
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Clock, systemClock } from "../core/clock.ts";
import { activeStep } from "../core/plan.ts";
import { type Trip, trippedRules } from "../core/rules.ts";
import { stepBudget } from "../core/status.ts";
import { type ActiveStep, currentTracker, type HarnessState, report } from "./state.ts";
import { isRefusal, type StepsApi } from "./steps.ts";

export interface BudgetApi {
	/**
	 * Apply the stop rules to the active step. Returns the text for the agent when a rule stopped
	 * the step, else null.
	 */
	enforce(ctx: ExtensionContext): Promise<string | null>;
	/**
	 * Stop the active step with `trip`, whatever the mode says: for the rules only a headless run
	 * trips. Returns the text for the agent, or null when no step is active.
	 */
	stop(ctx: ExtensionContext, trip: Trip): Promise<string | null>;
}

export function registerBudget(pi: ExtensionAPI, state: HarnessState, steps: StepsApi, clock: Clock = systemClock): BudgetApi {
	const enforce = async (ctx: ExtensionContext): Promise<string | null> => {
		const step = state.step;
		const tracker = currentTracker(state);
		if (!step || !tracker) return null;
		let config;
		try {
			config = steps.config();
		} catch (e) {
			if (!isRefusal(e)) throw e;
			report(state, `cannot check the budget of step ${step.step}: ${e.message}`);
			return null;
		}
		const budget = stepBudget(config, step);
		if (!budget) return null;
		// Each rule acts once per attempt; rule_tripped events record which have, across restarts.
		const done = new Set(tracker.tripped.map((r) => r.rule));
		const trips = trippedRules(tracker, budget, clock.now()).filter((r) => !done.has(r.rule));
		if (trips.length === 0) return null;
		const action = config.rules[state.mode];
		for (const r of trips) state.log?.write("rule_tripped", { rule: r.rule, action, value: r.value, limit: r.limit });
		if (action === "warn") {
			for (const r of trips) {
				report(state, `step ${step.step} tripped the stop rule ${r.rule}: ${r.why}. Work continues because rules.${state.mode} is "warn"; /abandon the step to end it.`, "warning");
			}
			return null;
		}
		return halt(ctx, step, trips[0]!);
	};

	/** End the step as stopped by `trip`, and refuse the rest of the agent's run, if one is going on. */
	const halt = async (ctx: ExtensionContext, step: ActiveStep, trip: Trip): Promise<string> => {
		const detail = `stop rule ${trip.rule}: ${trip.why}`;
		const text = `The harness stopped step ${step.step} (${detail}). Do not keep working on it and do not call more tools; stop here. A person decides what happens next.`;
		// Set only during a run: agent_settled clears it, and an idle session has none to come.
		if (!ctx.isIdle()) state.halt = text;
		try {
			const plan = await steps.activePlan(ctx);
			const current = activeStep(plan);
			if (current?.id === step.step && current.attempt === step.attempt) steps.finish(plan, step.step, "stopped", detail);
		} catch (e) {
			if (!isRefusal(e)) throw e;
			report(state, `step ${step.step} tripped ${detail}, but it could not be marked stopped: ${e.message}. Its run is stopped; /abandon the step.`);
			return text;
		}
		report(state, `step ${step.step} stopped by ${detail}. /retry-step ${step.step} starts a new attempt.`, "warning");
		return text;
	};

	const stop = async (ctx: ExtensionContext, trip: Trip): Promise<string | null> => {
		const step = state.step;
		if (!step) return null;
		state.log?.write("rule_tripped", { rule: trip.rule, action: "stop", value: trip.value, limit: trip.limit });
		return halt(ctx, step, trip);
	};

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		state.ctx = ctx;
		await enforce(ctx);
	});

	// After a stop, every further call in the run is refused with a reason the agent can read.
	// Blocked results end the batch only when all of its results terminate, so the run is also
	// aborted at the end of the turn; that abort is not an interruption by the person.
	pi.on("tool_call", async () => (state.halt ? { block: true, reason: state.halt, terminate: true } : undefined));
	pi.on("turn_end", async (_event, ctx) => {
		if (!state.halt || ctx.isIdle()) return;
		state.ownAbort = true;
		ctx.abort();
	});
	pi.on("agent_settled", async () => {
		state.halt = null;
	});

	return { enforce, stop };
}
