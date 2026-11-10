// Proposals (plan Sections 7.1 and 7.3): the agent suggests a step with propose_step; it becomes a
// step only when the person accepts it with /accept-step.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CommandError } from "../core/commands.ts";
import { acceptProposal, activeStep, addProposal, rejectProposal, startStep } from "../core/plan.ts";
import { formatProposals } from "../core/status.ts";
import { reply } from "./completion.ts";
import { type HarnessState, say } from "./state.ts";
import { isRefusal, registerHarnessCommand, type StepsApi } from "./steps.ts";

const words = (text: string) => text.trim().split(/\s+/).filter((w) => w !== "");

export function registerProposals(pi: ExtensionAPI, state: HarnessState, steps: StepsApi): void {
	const logProposal = (id: string, action: "proposed" | "accepted" | "rejected") => state.log?.write("proposal", { proposal_id: id, action });

	pi.registerTool({
		name: "propose_step",
		label: "Propose step",
		description:
			"Suggest a step for the person to consider next. It does not create or start a step, and it does not end your current work. A person accepts or rejects it later.",
		parameters: Type.Object({
			kind: Type.String({ description: "The step's kind, one of the kinds in harness.json." }),
			goal: Type.String({ description: "What the step should achieve, in one sentence." }),
			check_args: Type.Optional(Type.Array(Type.String(), { description: "Arguments for the kind's check script, such as a region name." })),
			rationale: Type.String({ description: "Why this step should come next: what you saw that suggests it." }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			state.ctx = ctx;
			try {
				const plan = await steps.activePlan(ctx);
				const kinds = Object.keys(steps.config().kinds);
				if (!kinds.includes(params.kind)) return reply(`Unknown kind "${params.kind}". Known kinds: ${kinds.join(", ")}. Nothing was recorded.`, { isError: true });
				const { plan: next, proposal } = addProposal(plan, {
					kind: params.kind,
					goal: params.goal,
					check_args: params.check_args ?? [],
					rationale: params.rationale,
					proposed_in_step: activeStep(plan)?.id ?? null,
				});
				steps.store().write(next);
				logProposal(proposal.id, "proposed");
				return reply(`Recorded proposal ${proposal.id}. It is not a step: a person will accept or reject it. Carry on with your current work.`);
			} catch (e) {
				if (isRefusal(e)) return reply(e.message, { isError: true });
				throw e;
			}
		},
	});

	const command = (name: string, description: string, handler: Parameters<typeof registerHarnessCommand>[4]) =>
		registerHarnessCommand(pi, state, name, description, handler);

	command("proposals", "List the open proposals", async (_args, ctx) => {
		say(state, formatProposals(await steps.activePlan(ctx)));
	});

	command("accept-step", "Turn a proposal into a pending step; with start, also start it: /accept-step <proposal_id> [start]", async (args, ctx) => {
		const [id, flag, ...extra] = words(args);
		if (id === undefined || extra.length > 0 || (flag !== undefined && flag !== "start")) throw new CommandError("usage: /accept-step <proposal_id> [start]");
		const start = flag === "start";
		if (start) steps.requireIdle(ctx);
		const { plan, step } = acceptProposal(await steps.activePlan(ctx), id);
		const kinds = Object.keys(steps.config().kinds);
		if (!kinds.includes(step.kind)) {
			throw new CommandError(`proposal ${id} has kind "${step.kind}", which harness.json no longer defines (kinds: ${kinds.join(", ")}); add the kind back or /reject-step ${id}. Nothing was changed.`);
		}
		if (!start) {
			steps.store().write(plan);
			logProposal(id, "accepted");
			return say(state, `Accepted ${id} as pending step ${step.id} (${step.kind}): ${step.goal}`);
		}
		// All or nothing: a refused start leaves the proposal open and the plan unchanged.
		try {
			steps.begin(startStep(plan, step.id), { ...step, status: "active" }, () => logProposal(id, "accepted"));
		} catch (e) {
			if (isRefusal(e)) throw new CommandError(`${e.message}. Proposal ${id} was not accepted and is still open.`);
			throw e;
		}
	});

	command("reject-step", "Mark a proposal rejected: /reject-step <proposal_id> [reason]", async (args, ctx) => {
		const [id] = words(args);
		if (id === undefined) throw new CommandError("usage: /reject-step <proposal_id> [reason]");
		const reason = args.trim().slice(id.length).trim();
		steps.store().write(rejectProposal(await steps.activePlan(ctx), id, reason));
		logProposal(id, "rejected");
		say(state, `Rejected ${id}${reason ? `: ${reason}` : "."}`);
	});
}
