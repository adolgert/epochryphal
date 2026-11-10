// /run-plan and /stop-plan (plan Section 7.8). The mode starts steps through the same begin() as
// /next-step. After each run settles, decideBoundary (core) says whether the next step starts; only
// a step that passed in that run leads on. The mode is session state and is not saved: after a
// restart the session is supervised (Section 8).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rebuildTracker } from "../core/budget.ts";
import { CommandError } from "../core/commands.ts";
import { readEvents, type StepRef } from "../core/log.ts";
import { activeStep, firstPending, type Plan, startStep } from "../core/plan.ts";
import { type Approval, type BoundaryAnswer, type BoundaryInput, boundarySummary, decideBoundary, parseRunPlanArgs } from "../core/runplan.ts";
import { formatPlanStatus } from "../core/status.ts";
import { attemptEvents } from "../core/steps.ts";
import { type HarnessState, report, say } from "./state.ts";
import { isRefusal, registerHarnessCommand, type StepsApi } from "./steps.ts";

interface Run {
	/** The step this run of the mode started last. */
	current: StepRef;
	started: number;
	limit: number | null;
	stopRequested: boolean;
}

const CHOICES: Record<string, BoundaryAnswer> = { Continue: "continue", Stop: "stop", "Stop and edit the plan": "stop_edit" };

export function registerRunPlan(pi: ExtensionAPI, state: HarnessState, steps: StepsApi): void {
	let run: Run | null = null;

	const end = (why: string, level: "info" | "warning") => {
		run = null;
		if (state.mode === "run_plan") state.mode = "supervised";
		const text = `run-plan ended: ${why}. The session is supervised again.`;
		if (level === "info") say(state, text);
		else report(state, text, "warning");
	};

	/** Mark the step active, start it through begin(), and count it. */
	const startNext = (r: Run, plan: Plan, id: string) => {
		const step = plan.steps.find((s) => s.id === id)!;
		steps.begin(startStep(plan, id), { ...step, status: "active" });
		r.current = { plan: plan.plan_id, step: id, attempt: step.attempt };
		r.started++;
	};

	/** The boundary summary of a step that passed, from its events in the log. */
	const summaryOf = (ref: StepRef, plan: Plan): string => {
		const own = state.log ? attemptEvents(readEvents(state.log.path), ref) : [];
		const check = own.findLast((e) => e.type === "check");
		const t = rebuildTracker(own, ref);
		const next = firstPending(plan);
		return boundarySummary({
			step: { id: ref.step, goal: plan.steps.find((s) => s.id === ref.step)?.goal ?? "" },
			check: typeof check?.summary === "string" ? check.summary : null,
			tokens: t.tokens,
			cost_usd: t.cost_usd,
			next: next ? { id: next.id, goal: next.goal } : null,
		});
	};

	const boundary = async (r: Run, aborted: boolean, ctx: ExtensionContext) => {
		const plan = await steps.activePlan(ctx);
		const found = plan.plan_id === r.current.plan ? plan.steps.find((s) => s.id === r.current.step && s.attempt === r.current.attempt) : undefined;
		const next = firstPending(plan);
		const input = (approval: Approval): BoundaryInput => ({
			step: { id: r.current.step, status: found?.status ?? ("missing" as const), reason: found?.reason },
			aborted,
			next: next ?? null,
			started: r.started,
			limit: r.limit,
			stopRequested: r.stopRequested,
			approval,
		});
		const approve = steps.config().run_plan.approve;
		let decision = decideBoundary(input(approve === "ask" && !ctx.hasUI ? "no_ui" : approve));
		const summary = found?.status === "passed" ? summaryOf(r.current, plan) : null;
		if (decision.action === "ask") {
			const choice = await ctx.ui.select(`${summary}\n\nStart ${next!.id}?`, Object.keys(CHOICES));
			// Escape (no choice) counts as stop. Decide again: /stop-plan may have come meanwhile.
			decision = decideBoundary(input(CHOICES[choice ?? "Stop"] ?? "stop"));
		} else if (summary) {
			say(state, summary); // With auto, and when the mode ends after a pass, a notice records the boundary.
		}
		if (decision.action === "continue") return startNext(r, plan, next!.id);
		// A second "ask" cannot happen (an answer is given); it would end the mode, not continue.
		end("why" in decision ? decision.why : "no answer at the boundary", found?.status === "passed" ? "info" : "warning");
		if ("edit" in decision && decision.edit) {
			say(state, `${formatPlanStatus(plan, steps.config())}\nEdit the pending steps in ${steps.store().pathOf(plan.plan_id)} or with /add-step; the harness asks you to accept a hand edit. Then /run-plan goes on.`);
		}
	};

	pi.on("session_start", async () => {
		// A new session is supervised; the mode is never restored.
		run = null;
		if (state.mode === "run_plan") state.mode = "supervised";
	});

	pi.on("agent_settled", async (event, ctx) => {
		const r = run;
		if (!r) return;
		// The step's prompt was sent but its run has not begun: this settle is of another run.
		const s = state.starting;
		if (s && s.plan === r.current.plan && s.step === r.current.step && s.attempt === r.current.attempt) return;
		state.ctx = ctx;
		try {
			await boundary(r, event.aborted, ctx);
		} catch (e) {
			// A refused start (kind, git, protected files) or an unreadable plan ends the mode.
			end(isRefusal(e) ? e.message : `error at the step boundary: ${(e as Error).message}`, "warning");
			if (!isRefusal(e)) throw e;
		}
	});

	registerHarnessCommand(pi, state, "run-plan", "Run pending steps one after another, pausing at each boundary: /run-plan [n]", async (args, ctx) => {
		const limit = parseRunPlanArgs(args);
		if (run) throw new CommandError("run-plan is already on; /stop-plan ends it after the current step");
		steps.requireIdle(ctx);
		const plan = await steps.activePlan(ctx);
		const active = activeStep(plan);
		if (active) throw new CommandError(`step ${active.id} is active; finish it or /abandon it, then /run-plan`);
		const next = firstPending(plan);
		if (!next) throw new CommandError(`plan ${plan.plan_id} has no pending step; add some with /add-step`);
		const r: Run = { current: { plan: plan.plan_id, step: next.id, attempt: next.attempt }, started: 0, limit, stopRequested: false };
		run = r;
		state.mode = "run_plan"; // Before begin(), so step_start carries it.
		try {
			startNext(r, plan, next.id);
		} catch (e) {
			run = null;
			state.mode = "supervised";
			throw e;
		}
		say(state, `run-plan on: ${limit === null ? "all pending steps" : `up to ${limit} step${limit === 1 ? "" : "s"}`}, approve: ${steps.config().run_plan.approve}. /stop-plan ends it after the current step.`);
	});

	registerHarnessCommand(pi, state, "stop-plan", "End run-plan after the current step", () => {
		if (!run) return say(state, "run-plan is not on; nothing to stop.");
		run.stopRequested = true;
		say(state, `run-plan ends when step ${run.current.step} ends; that step keeps going.`);
	});
}
