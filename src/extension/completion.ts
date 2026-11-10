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
import type { HarnessState } from "./state.ts";
import { isRefusal, type StepsApi } from "./steps.ts";

export const reply = (text: string, extra: { isError?: boolean; terminate?: boolean } = {}) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
	...extra,
});

export function registerCompletion(pi: ExtensionAPI, state: HarnessState, steps: StepsApi, clock?: Clock): void {
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

	pi.registerTool({
		name: "submit",
		label: "Submit step",
		description:
			"Call this when you believe the active harness step is complete. It runs the step's check. The step is finished only if the check passes; otherwise you get the check's summary and keep working.",
		parameters: Type.Object({ note: Type.Optional(Type.String({ description: "Optional short note for the log about what you did." })) }),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			return guarded(ctx, async () => {
				const { plan, step } = await active(ctx, "submit");
				const result = await runCheck({
					root: state.root!,
					harnessDir: state.harnessDir,
					config: steps.config(),
					plan: plan.plan_id,
					step,
					baseCommit: state.step?.step === step.id && state.step.attempt === step.attempt ? state.step.commit : null,
					by: "submit",
					log: state.log,
					signal,
					clock,
				});
				if (result.status !== "passed") return reply(result.text, { isError: true });
				// Read again: the person may have ended the step while the check ran.
				const now = await active(ctx, "submit");
				if (now.step.id !== step.id || now.step.attempt !== step.attempt) return reply(`${result.text}\nBut step ${step.id} ended while the check ran; nothing was changed.`, { isError: true });
				steps.finish(now.plan, step.id, "passed", params.note?.trim() || null);
				return reply(`${result.text}\nStep ${step.id} passed. Stop here.`, { terminate: true });
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
}
