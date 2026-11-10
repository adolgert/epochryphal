// The text of /plan-status.
import type { Budget, HarnessConfig } from "./config.ts";
import type { Plan, Step } from "./plan.ts";

/** The budget for a step: its kind's budget with the step's own fields on top. */
export function stepBudget(config: HarnessConfig, step: Step): Budget | undefined {
	const base = config.kinds[step.kind]?.budget;
	return base ? { ...base, ...step.budget } : undefined;
}

export function formatPlanStatus(plan: Plan, config: HarnessConfig): string {
	const lines = [`Plan ${plan.plan_id}: ${plan.goal}`];
	if (plan.exit) lines.push(`Closed: ${plan.exit.decision} (${plan.exit.at}): ${plan.exit.note}`);
	if (plan.steps.length === 0) lines.push("No steps yet. Add one with /step or /add-step.");
	for (const s of plan.steps) {
		const args = s.check_args.length > 0 ? ` [${s.check_args.join(" ")}]` : "";
		const attempt = s.attempt > 1 ? ` attempt ${s.attempt}` : "";
		const reason = s.reason ? ` (${s.reason})` : "";
		lines.push(`  ${s.id} ${s.status.padEnd(9)} ${s.kind}${args}${attempt}: ${s.goal}${reason}`);
	}
	const open = plan.proposals.filter((p) => p.state === "open");
	if (open.length > 0) {
		lines.push("Open proposals:");
		for (const p of open) lines.push(`  ${p.id} ${p.kind}: ${p.goal}`);
	}
	const active = plan.steps.find((s) => s.status === "active");
	const budget = active && stepBudget(config, active);
	if (active && budget) {
		lines.push(
			`Budget for ${active.id}: ${budget.tokens} tokens, $${budget.cost_usd}, ${budget.agent_minutes} agent minutes, ${budget.check_attempts} check attempts`,
		);
	}
	return lines.join("\n");
}
