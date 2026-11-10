// The person's plan and step commands (plan Section 7.1), the step prompt (7.2), and restoring
// the active step when a session starts (Section 8).
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { type Clock, systemClock } from "../core/clock.ts";
import { CommandError, parseStepArgs, parseWordAndText } from "../core/commands.ts";
import { ConfigError, type HarnessConfig, loadConfig } from "../core/config.ts";
import {
	activeStep,
	addStep,
	closePlan,
	type ExitDecision,
	endStep,
	firstPending,
	newPlan,
	type Plan,
	PlanError,
	PlanStore,
	retryStep,
	type Step,
	type StepOutcome,
	startStep,
} from "../core/plan.ts";
import { readEvents, type StepRef } from "../core/log.ts";
import { activeStepLine, stepPrompt } from "../core/prompt.ts";
import { changedProtected, currentCommit, GitError } from "../core/protect.ts";
import { formatPlanStatus, planDifference } from "../core/status.ts";
import { appendStepRecord } from "../core/steps.ts";
import { type ActiveStep, type HarnessState, report, say } from "./state.ts";

const DECISIONS: ExitDecision[] = ["keep", "revert", "continue"];

/** Errors that are refusals with a message for the person or the agent, not bugs. */
export const isRefusal = (e: unknown): e is Error =>
	e instanceof CommandError || e instanceof PlanError || e instanceof ConfigError || e instanceof GitError;

/** What the completion tools need from the step commands. */
export interface StepsApi {
	store(): PlanStore;
	config(): HarnessConfig;
	activePlan(ctx: ExtensionContext): Promise<Plan>;
	/** End the active step: write the plan, log step_end, and clear the active step. */
	finish(plan: Plan, stepId: string, outcome: StepOutcome, detail: string | null): void;
}

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

/** Register a command whose expected failures are reported to the person instead of thrown. */
export function registerHarnessCommand(pi: ExtensionAPI, state: HarnessState, name: string, description: string, handler: CommandHandler): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			state.ctx = ctx;
			try {
				await handler(args, ctx);
			} catch (e) {
				if (isRefusal(e)) report(state, e.message);
				else throw e;
			}
		},
	});
}

export function registerSteps(pi: ExtensionAPI, state: HarnessState, clock: Clock = systemClock): StepsApi {
	const now = () => new Date(clock.now());

	/** The store, or a refusal that explains why the harness is inactive. */
	const store = (): PlanStore => {
		if (!state.store) throw new CommandError(`harness inactive: no ${state.harnessDir}/harness.json at or above the working directory`);
		return state.store;
	};
	const config = (): HarnessConfig => {
		store();
		return loadConfig(state.root!, state.harnessDir);
	};

	/**
	 * The active plan. A plan changed on disk by someone else is used only when the person accepts
	 * the change in a dialog. Without a user interface it is refused and logged.
	 */
	const activePlan = async (ctx: ExtensionContext): Promise<Plan> => {
		const s = store();
		const id = s.activeId();
		if (id === null) throw new CommandError("no active plan; create one with /plan-new <plan_id> <goal> or choose one with /plan-use <plan_id>");
		const { plan, changedExternally, hash, previous } = s.read(id);
		if (!changedExternally) return plan;
		const difference = planDifference(previous, plan);
		if (!ctx.hasUI) {
			state.log?.write("plan_changed_externally", { plan: id });
			throw new CommandError(`plan ${id} was changed outside the harness (${difference}); without a user interface the change is not accepted. Nothing was done.`);
		}
		// The hash is of the text read above: a later change is caught by the next read.
		if (!(await ctx.ui.confirm(`Plan ${id} was changed outside the harness`, `${difference}\nUse the plan file as it is now?`))) {
			throw new CommandError(`the change to plan ${id} was not accepted; nothing was done`);
		}
		s.accept(id, hash);
		syncActive(plan);
		return plan;
	};

	/** The commit in the step_start event of a step attempt, or null when the log has none. */
	const recordedCommit = (ref: StepRef): string | null => {
		const path = join(state.root!, state.harnessDir, "log", "events.jsonl");
		const start = readEvents(path).findLast(
			(e) => e.type === "step_start" && e.plan === ref.plan && e.step === ref.step && e.attempt === ref.attempt,
		);
		return typeof start?.commit === "string" ? start.commit : null;
	};

	/** Make state.step match the plan's active step. `commit` is given when the step starts now. */
	const syncActive = (plan: Plan | null, commit?: string) => {
		const step = plan && activeStep(plan);
		if (!step) return void (state.step = null);
		const ref = { plan: plan.plan_id, step: step.id, attempt: step.attempt };
		const same = state.step?.plan === ref.plan && state.step.step === ref.step && state.step.attempt === ref.attempt;
		state.step = { ...ref, kind: step.kind, goal: step.goal, commit: commit ?? (same ? state.step!.commit : recordedCommit(ref)) };
	};

	const finish = (plan: Plan, stepId: string, outcome: StepOutcome, detail: string | null) => {
		const attempt = plan.steps.find((s) => s.id === stepId)?.attempt;
		store().write(endStep(plan, stepId, outcome, detail ?? undefined));
		state.log?.write("step_end", { outcome, detail });
		syncActive(null);
		if (attempt === undefined || !state.log) return;
		// The record is built from the event log, so it also covers work done before a restart.
		const stepsPath = join(dirname(state.log.path), "steps.jsonl");
		try {
			appendStepRecord(state.log.path, stepsPath, { plan: plan.plan_id, step: stepId, attempt });
		} catch (e) {
			report(state, `cannot write the step record to ${stepsPath}: ${(e as Error).message}. The step still ended as ${outcome}; its events are in ${state.log.path}.`);
		}
	};

	const requireIdle = (ctx: ExtensionCommandContext) => {
		if (!ctx.isIdle()) throw new CommandError("the agent is working; wait for it to finish, or press Escape, then try again");
	};

	const requireNoActiveStep = (what: string) => {
		if (state.step) throw new CommandError(`step ${state.step.step} of plan ${state.step.plan} is active; finish it or /abandon it before ${what}`);
	};

	/** Write a plan whose step is now active, log it, and hand the step to the agent. */
	const begin = (plan: Plan, step: Step) => {
		// Every refusal comes before the first write: the plan, state, and log stay untouched.
		const cfg = config();
		if (!cfg.kinds[step.kind]) {
			throw new CommandError(`step ${step.id} has kind "${step.kind}", which harness.json no longer defines (kinds: ${Object.keys(cfg.kinds).join(", ")}); add the kind back or change the step in the plan file`);
		}
		const commit = currentCommit(state.root!);
		const dirty = changedProtected(state.root!, commit, cfg.protected);
		if (dirty.length > 0) throw new CommandError(`protected files have uncommitted changes: ${dirty.join(", ")}; commit or restore them before starting a step`);
		const prompt = stepPrompt(plan, step, cfg.protected);
		store().write(plan);
		syncActive(plan, commit);
		state.log?.write("step_start", { kind: step.kind, goal: step.goal, origin: step.origin, commit });
		state.starting = { plan: plan.plan_id, step: step.id, attempt: step.attempt, prompt };
		pi.sendUserMessage(prompt);
	};

	const command = (name: string, description: string, handler: CommandHandler) => registerHarnessCommand(pi, state, name, description, handler);

	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		state.step = null;
		state.starting = null;
		state.store = state.root ? new PlanStore(state.root, state.harnessDir) : null;
		if (!state.store) return;
		try {
			const id = state.store.activeId();
			syncActive(id && state.store.exists(id) ? state.store.read(id).plan : null);
			const restored = state.step as ActiveStep | null; // syncActive set it; TypeScript cannot see that.
			if (restored && restored.commit === null) {
				report(state, `step ${restored.step} is active, but the log has no commit for when it started, so submit cannot check protected files; /abandon it and /retry-step`, "warning");
			}
		} catch (e) {
			report(state, `cannot restore the active plan: ${(e as Error).message}`);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const starting = state.starting;
		if (starting && event.messageType === "user" && event.prompt === starting.prompt) {
			state.starting = null;
			// The step ended (by /abandon) after its prompt was sent but before its run began.
			if (state.step?.step !== starting.step || state.step.plan !== starting.plan || state.step.attempt !== starting.attempt) {
				state.ownAbort = true;
				ctx.abort();
				return;
			}
		}
		const sections = event.systemPromptOptions.sections;
		if (state.step) sections.harness = activeStepLine({ id: state.step.step, goal: state.step.goal });
		else delete sections.harness;
	});

	command("plan-new", "Create a plan and make it active: /plan-new <plan_id> <goal>", (args) => {
		const { word: id, text: goal } = parseWordAndText(args, "/plan-new <plan_id> <goal text>");
		requireNoActiveStep("starting a new plan");
		const s = store();
		s.create(newPlan(id, goal, now()));
		s.setActive(id);
		syncActive(null);
		say(state, `Plan ${id} created and active.`);
	});

	command("plan-use", "Make an existing plan active: /plan-use <plan_id>", (args) => {
		const id = args.trim();
		if (id === "") throw new CommandError("usage: /plan-use <plan_id>");
		requireNoActiveStep("switching plans");
		const s = store();
		const { plan, hash } = s.read(id);
		s.accept(id, hash); // The person chose this file as it is.
		s.setActive(id);
		syncActive(plan);
		say(state, `Plan ${id} is active.`);
	});

	command("plan-status", "Show the active plan, its steps, open proposals, and the active step's budget", async (_args, ctx) => {
		say(state, formatPlanStatus(await activePlan(ctx), config()));
	});

	command("plan-close", "Record the closing decision: /plan-close <keep|revert|continue> <note>", async (args, ctx) => {
		const { word, text: note } = parseWordAndText(args, "/plan-close <keep|revert|continue> <note>");
		if (!DECISIONS.includes(word as ExitDecision)) throw new CommandError(`the decision must be one of ${DECISIONS.join(", ")}`);
		const plan = closePlan(await activePlan(ctx), word as ExitDecision, note, now());
		store().write(plan);
		say(state, `Plan ${plan.plan_id} closed: ${word}.`);
	});

	command("step", "Add a step and start it: /step <kind> [check args...] -- <goal>", async (args, ctx) => {
		requireIdle(ctx);
		const plan = await activePlan(ctx);
		const spec = parseStepArgs(args, Object.keys(config().kinds));
		const added = addStep(plan, spec);
		begin(startStep(added.plan, added.step.id), { ...added.step, status: "active" });
	});

	command("add-step", "Add a step without starting it: /add-step <kind> [check args...] -- <goal>", async (args, ctx) => {
		const spec = parseStepArgs(args, Object.keys(config().kinds));
		const { plan, step } = addStep(await activePlan(ctx), spec);
		store().write(plan);
		say(state, `Added ${step.id} (${step.kind}): ${step.goal}`);
	});

	command("next-step", "Start the first pending step", async (_args, ctx) => {
		requireIdle(ctx);
		const plan = await activePlan(ctx);
		const step = firstPending(plan);
		if (!step) throw new CommandError(`plan ${plan.plan_id} has no pending step; add one with /add-step or /step`);
		begin(startStep(plan, step.id), { ...step, status: "active" });
	});

	command("retry-step", "Start a blocked, abandoned, or stopped step again: /retry-step [step_id]", async (args, ctx) => {
		requireIdle(ctx);
		const { plan, step } = retryStep(await activePlan(ctx), args.trim() || undefined);
		begin(plan, step);
	});

	command("abandon", "End the active step as abandoned: /abandon <reason>", async (args, ctx) => {
		const reason = args.trim();
		if (reason === "") throw new CommandError("usage: /abandon <reason>");
		if (!state.step) throw new CommandError("no step is active");
		const stopRun = async () => {
			if (ctx.isIdle()) return;
			state.ownAbort = true; // The outcome "abandoned" records this; it is not an interruption.
			ctx.abort();
			await ctx.waitForIdle();
		};
		await stopRun();
		// Read after the agent has stopped: the step may have ended meanwhile.
		const plan = await activePlan(ctx);
		const step = activeStep(plan);
		if (!step) throw new CommandError("no step is active");
		finish(plan, step.id, "abandoned", reason);
		// The step's own run may have begun meanwhile, if /step was sent just before. Stop it too;
		// if it has not begun, before_agent_start stops it.
		await stopRun();
		say(state, `Step ${step.id} abandoned: ${reason}`);
	});

	return { store, config, activePlan, finish };
}
