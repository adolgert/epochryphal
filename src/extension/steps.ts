// The person's plan and step commands (plan Section 7.1), the step prompt (7.2), and restoring
// the active step when a session starts (Section 8).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
	startStep,
} from "../core/plan.ts";
import { activeStepLine, stepPrompt } from "../core/prompt.ts";
import { formatPlanStatus } from "../core/status.ts";
import { type HarnessState, report, say } from "./state.ts";

const DECISIONS: ExitDecision[] = ["keep", "revert", "continue"];

export function registerSteps(pi: ExtensionAPI, state: HarnessState, clock: Clock = systemClock): void {
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

	/** The active plan. A plan changed on disk by someone else is accepted with a notice. */
	const activePlan = (): Plan => {
		const s = store();
		const id = s.activeId();
		if (id === null) throw new CommandError("no active plan; create one with /plan-new <plan_id> <goal> or choose one with /plan-use <plan_id>");
		const { plan, changedExternally, hash } = s.read(id);
		if (changedExternally) {
			report(state, `plan ${id} was changed outside the harness; using the file as it is now`, "warning");
			s.accept(id, hash);
			syncActive(plan);
		}
		return plan;
	};

	/** Make state.step match the plan's active step. */
	const syncActive = (plan: Plan | null) => {
		const step = plan && activeStep(plan);
		state.step = step ? { plan: plan.plan_id, step: step.id, attempt: step.attempt, kind: step.kind, goal: step.goal } : null;
	};

	const requireIdle = (ctx: ExtensionCommandContext) => {
		if (!ctx.isIdle()) throw new CommandError("the agent is working; wait for it to finish, or press Escape, then try again");
	};

	const requireNoActiveStep = (what: string) => {
		if (state.step) throw new CommandError(`step ${state.step.step} of plan ${state.step.plan} is active; finish it or /abandon it before ${what}`);
	};

	/** Write a plan whose step is now active, log it, and hand the step to the agent. */
	const begin = (plan: Plan, step: Step) => {
		// Build the prompt first: a broken harness.json must leave the plan, state, and log untouched.
		const prompt = stepPrompt(plan, step, config().protected);
		store().write(plan);
		syncActive(plan);
		state.log?.write("step_start", { kind: step.kind, goal: step.goal, origin: step.origin });
		pi.sendUserMessage(prompt);
	};

	/** Register a command whose expected failures are reported to the person instead of thrown. */
	const command = (name: string, description: string, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				state.ctx = ctx;
				try {
					await handler(args, ctx);
				} catch (e) {
					if (e instanceof CommandError || e instanceof PlanError || e instanceof ConfigError) report(state, e.message);
					else throw e;
				}
			},
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		state.step = null;
		state.store = state.root ? new PlanStore(state.root, state.harnessDir) : null;
		if (!state.store) return;
		try {
			const id = state.store.activeId();
			syncActive(id && state.store.exists(id) ? state.store.read(id).plan : null);
		} catch (e) {
			report(state, `cannot restore the active plan: ${(e as Error).message}`);
		}
	});

	pi.on("before_agent_start", async (event) => {
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
		const { plan } = s.read(id);
		s.setActive(id);
		syncActive(plan);
		say(state, `Plan ${id} is active.`);
	});

	command("plan-status", "Show the active plan, its steps, open proposals, and the active step's budget", () => {
		say(state, formatPlanStatus(activePlan(), config()));
	});

	command("plan-close", "Record the closing decision: /plan-close <keep|revert|continue> <note>", (args) => {
		const { word, text: note } = parseWordAndText(args, "/plan-close <keep|revert|continue> <note>");
		if (!DECISIONS.includes(word as ExitDecision)) throw new CommandError(`the decision must be one of ${DECISIONS.join(", ")}`);
		const plan = closePlan(activePlan(), word as ExitDecision, note, now());
		store().write(plan);
		say(state, `Plan ${plan.plan_id} closed: ${word}.`);
	});

	command("step", "Add a step and start it: /step <kind> [check args...] -- <goal>", (args, ctx) => {
		requireIdle(ctx);
		const plan = activePlan();
		const spec = parseStepArgs(args, Object.keys(config().kinds));
		const added = addStep(plan, spec);
		begin(startStep(added.plan, added.step.id), { ...added.step, status: "active" });
	});

	command("add-step", "Add a step without starting it: /add-step <kind> [check args...] -- <goal>", (args) => {
		const spec = parseStepArgs(args, Object.keys(config().kinds));
		const { plan, step } = addStep(activePlan(), spec);
		store().write(plan);
		say(state, `Added ${step.id} (${step.kind}): ${step.goal}`);
	});

	command("next-step", "Start the first pending step", (_args, ctx) => {
		requireIdle(ctx);
		const plan = activePlan();
		const step = firstPending(plan);
		if (!step) throw new CommandError(`plan ${plan.plan_id} has no pending step; add one with /add-step or /step`);
		begin(startStep(plan, step.id), { ...step, status: "active" });
	});

	command("retry-step", "Start a blocked, abandoned, or stopped step again: /retry-step [step_id]", (args, ctx) => {
		requireIdle(ctx);
		const { plan, step } = retryStep(activePlan(), args.trim() || undefined);
		begin(plan, step);
	});

	command("abandon", "End the active step as abandoned: /abandon <reason>", async (args, ctx) => {
		const reason = args.trim();
		if (reason === "") throw new CommandError("usage: /abandon <reason>");
		if (!state.step) throw new CommandError("no step is active");
		if (!ctx.isIdle()) {
			ctx.abort();
			await ctx.waitForIdle();
		}
		// Read after the agent has stopped: the step may have ended meanwhile.
		const plan = activePlan();
		const step = activeStep(plan);
		if (!step) throw new CommandError("no step is active");
		store().write(endStep(plan, step.id, "abandoned", reason));
		state.log?.write("step_end", { outcome: "abandoned", detail: reason });
		syncActive(null);
		say(state, `Step ${step.id} abandoned: ${reason}`);
	});
}
