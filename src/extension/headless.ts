// What the headless runner (src/runner/) calls inside the extension instance of its session. Each
// call goes through the same functions as the commands and tools: the runner adds no step logic.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sameAttempt } from "../core/budget.ts";
import type { StepRef } from "../core/log.ts";
import { type Plan, type Step, startStep } from "../core/plan.ts";
import type { HeadlessRule } from "../core/rules.ts";
import type { StepRecord } from "../core/steps.ts";
import type { BudgetApi } from "./budget.ts";
import type { CompletionApi, StepCheck } from "./completion.ts";
import { type HarnessState, report } from "./state.ts";
import { isRefusal, type StepsApi } from "./steps.ts";

export interface RunnerHandle {
	/** The active plan. A plan changed by someone else ends the active step (plan_changed_externally). */
	plan(): Promise<Plan>;
	/** Start a pending step as /next-step does, without sending its prompt; returns the prompt. */
	start(plan: Plan, step: Step): { ref: StepRef; prompt: string };
	active(ref: StepRef): Promise<boolean>;
	/** The submit tool's check, by "runner". A refusal that leaves the step active stops it with check_error. */
	check(ref: StepRef, signal: AbortSignal): Promise<StepCheck>;
	stop(rule: HeadlessRule, why: string, value: number | null, limit: number | null): Promise<void>;
	/** The step record of an ended attempt. */
	record(ref: StepRef): StepRecord | null;
	/** Call before aborting a run: that abort is the harness's, not an interruption. */
	ownAbort(): void;
}

export function headlessHandle(state: HarnessState, steps: StepsApi, budget: BudgetApi, completion: CompletionApi): RunnerHandle {
	const ctx = (): ExtensionContext => {
		if (!state.ctx || !state.root) throw new Error("the harness is not active in this session; is there a harness/harness.json in the project?");
		return state.ctx;
	};
	const isActive = (ref: StepRef) => state.step !== null && sameAttempt(ref, state.step);
	const stop: RunnerHandle["stop"] = async (rule, why, value, limit) => {
		await budget.stop(ctx(), { rule, why, value, limit });
	};

	return {
		plan: () => steps.activePlan(ctx()),
		start(plan, step) {
			const prompt = steps.activate(startStep(plan, step.id), { ...step, status: "active" });
			return { ref: { plan: plan.plan_id, step: step.id, attempt: step.attempt }, prompt };
		},
		async active(ref) {
			try {
				await steps.activePlan(ctx()); // Reading the plan is what notices an outside change.
			} catch (e) {
				if (!isRefusal(e)) throw e;
				if (isActive(ref)) report(state, e.message); // When the change ended the step, that was reported.
			}
			return isActive(ref);
		},
		async check(ref, signal) {
			try {
				return await completion.checkStep(ctx(), "runner", null, signal);
			} catch (e) {
				if (!isRefusal(e)) throw e;
				if (isActive(ref)) await stop("check_error", `the check could not run: ${e.message}`, null, null);
				const ended = !isActive(ref);
				return { status: "error", summary: e.message, text: e.message, ended, stopRule: ended ? (steps.recordOf(ref)?.stop_rule ?? null) : null };
			}
		},
		stop,
		record: (ref) => steps.recordOf(ref),
		ownAbort() {
			state.ownAbort = true;
		},
	};
}
