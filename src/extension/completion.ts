// The agent's completion tools, submit and report_blocked (plan Section 7.3), and the guard on
// pi's built-in edit and write tools (Section 7.4).
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Clock } from "../core/clock.ts";
import { runCheck } from "../core/check.ts";
import { CommandError } from "../core/commands.ts";
import { loadConfig } from "../core/config.ts";
import { activeStep, type Plan, type Step } from "../core/plan.ts";
import { guardReason, projectPath } from "../core/protect.ts";
import type { LoopCheck } from "../core/headless.ts";
import type { BudgetApi } from "./budget.ts";
import type { HarnessState } from "./state.ts";
import { isRefusal, type StepsApi } from "./steps.ts";

export const reply = (text: string, extra: { isError?: boolean; terminate?: boolean } = {}) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
	...extra,
});

/** A check of the active step, as submit and the headless runner see it. */
export interface StepCheck extends LoopCheck {
	/** What the agent is shown. */
	text: string;
}

export interface CompletionApi {
	/**
	 * Check the active step (Section 7.3): on a pass end it as passed; after a failure apply the
	 * stop rules for check attempts and stalls; for a broken check in a headless run, stop it with
	 * check_error. Throws a refusal when no step is active. Used by submit and by the runner.
	 */
	checkStep(ctx: ExtensionContext, by: "submit" | "runner", note: string | null, signal: AbortSignal | undefined): Promise<StepCheck>;
}

export function registerCompletion(pi: ExtensionAPI, state: HarnessState, steps: StepsApi, budget: BudgetApi, clock?: Clock): CompletionApi {
	/** The plan and its active step. Throws a refusal when there is none. */
	const active = async (ctx: ExtensionContext, tool: string): Promise<{ plan: Plan; step: Step }> => {
		const plan = await steps.activePlan(ctx);
		const step = activeStep(plan);
		if (!step) throw new CommandError(`No harness step is active, so ${tool} has nothing to act on. Nothing was changed.`);
		return { plan, step };
	};

	/** Run a tool body; a refusal is returned to the agent as an error result. */
	const guarded = async (ctx: ExtensionContext, body: () => Promise<ReturnType<typeof reply>>) => {
		state.ctx = ctx;
		try {
			return await body();
		} catch (e) {
			if (isRefusal(e)) return reply(e.message, { isError: true });
			throw e;
		}
	};

	const checkStep: CompletionApi["checkStep"] = async (ctx, by, note, signal) => {
		const who = by === "submit" ? "submit" : "the runner's check";
		const { plan, step } = await active(ctx, who);
		const result = await runCheck({
			root: state.root!,
			harnessDir: state.harnessDir,
			config: steps.config(),
			plan: plan.plan_id,
			step,
			baseCommit: state.step?.step === step.id && state.step.attempt === step.attempt ? state.step.commit : null,
			by,
			log: state.log,
			signal,
			clock,
		});
		const ref = { plan: plan.plan_id, step: step.id, attempt: step.attempt };
		const out = (text: string, ended: boolean): StepCheck => ({
			status: result.status,
			summary: result.status === "failed" ? result.summary : text,
			text,
			ended,
			stopRule: ended && result.status !== "passed" ? (steps.recordOf(ref)?.stop_rule ?? null) : null,
		});
		if (result.status === "failed") {
			// Section 7.3 item 6: after a failed check, the rules on check attempts and stalls.
			const stopped = await budget.enforce(ctx);
			return out(stopped ? `${result.text}\n\n${stopped}` : result.text, stopped !== null);
		}
		if (result.status === "error" && state.mode === "headless") {
			// Nobody can fix the check during a headless run, so report_blocked would only wait for a person.
			const stopped = await budget.stop(ctx, { rule: "check_error", value: null, limit: null, why: `the check script is broken: ${result.problem}` });
			return out(stopped ?? result.text, stopped !== null);
		}
		if (result.status !== "passed") return out(result.text, false);
		// Read again: the person may have ended the step while the check ran.
		const now = await active(ctx, who);
		if (now.step.id !== step.id || now.step.attempt !== step.attempt) return out(`${result.text}\nBut step ${step.id} ended while the check ran; nothing was changed.`, false);
		steps.finish(now.plan, step.id, "passed", note);
		return out(`${result.text}\nStep ${step.id} passed. Stop here.`, true);
	};

	pi.registerTool({
		name: "submit",
		label: "Submit step",
		description:
			"Call this when you believe the active harness step is complete. It runs the step's check. The step is finished only if the check passes; otherwise you get the check's summary and keep working.",
		parameters: Type.Object({ note: Type.Optional(Type.String({ description: "Optional short note for the log about what you did." })) }),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			return guarded(ctx, async () => {
				const c = await checkStep(ctx, "submit", params.note?.trim() || null, signal);
				return reply(c.text, { isError: !(c.status === "passed" && c.ended), ...(c.ended ? { terminate: true } : {}) });
			});
		},
	});

	pi.registerTool({
		name: "report_blocked",
		label: "Report blocked",
		description:
			"Call this when you cannot finish the active harness step: something is missing, broken, or outside what you may change. The step is marked blocked and a person looks at it.",
		parameters: Type.Object({ reason: Type.String({ description: "What blocks you, and what you tried." }) }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return guarded(ctx, async () => {
				const reason = params.reason.trim();
				if (reason === "") return reply("report_blocked needs a reason: say what blocks you. Nothing was changed.", { isError: true });
				const { plan, step } = await active(ctx, "report_blocked");
				steps.finish(plan, step.id, "blocked", reason);
				return reply(`Step ${step.id} is marked blocked. A person will look at it. Stop working on this step.`, { terminate: true });
			});
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (state.root === null) return;
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const path = projectPath(state.root, ctx.cwd, event.input.path);
		if (path === null) return;
		let patterns: string[];
		try {
			patterns = loadConfig(state.root, state.harnessDir).protected;
		} catch {
			patterns = [`${state.harnessDir}/**`]; // Patterns unknown: keep the whole harness directory safe.
		}
		const why = guardReason(path, patterns, state.harnessDir);
		if (why === null) return;
		state.log?.write("guard_block", { tool: event.toolName, path });
		return { block: true, reason: `${path} must not be changed by the agent: ${why}. Leave it as it is; if the step needs it changed, call report_blocked and say why.` };
	});

	return { checkStep };
}
