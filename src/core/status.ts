// The text of /plan-status and /proposals.
import type { Usage } from "./budget.ts";
import type { Budget, HarnessConfig } from "./config.ts";
import type { Plan, Step } from "./plan.ts";

/** The budget for a step: its kind's budget with the step's own fields on top. */
export function stepBudget(config: HarnessConfig, step: Pick<Step, "kind" | "budget">): Budget | undefined {
	const base = config.kinds[step.kind]?.budget;
	return base ? { ...base, ...step.budget } : undefined;
}

/** `usage` is the active step's usage so far, when known. */
export function formatPlanStatus(plan: Plan, config: HarnessConfig, usage?: Usage): string {
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
	if (active && budget && usage) {
		const cost = Math.round(usage.cost_usd * 10_000) / 10_000;
		const minutes = Math.round(usage.agent_minutes * 10) / 10;
		lines.push(
			`Usage of ${active.id}: ${usage.tokens} of ${budget.tokens} tokens, $${cost} of $${budget.cost_usd}, ${minutes} of ${budget.agent_minutes} agent minutes, ${usage.check_attempts} of ${budget.check_attempts} check attempts`,
		);
	} else if (active && budget) {
		lines.push(
			`Budget for ${active.id}: ${budget.tokens} tokens, $${budget.cost_usd}, ${budget.agent_minutes} agent minutes, ${budget.check_attempts} check attempts`,
		);
	}
	return lines.join("\n");
}

/** The text of /proposals: the open proposals with their rationale. */
export function formatProposals(plan: Plan): string {
	const open = plan.proposals.filter((p) => p.state === "open");
	if (open.length === 0) return `Plan ${plan.plan_id} has no open proposals.`;
	const lines = [`Open proposals in plan ${plan.plan_id}:`];
	for (const p of open) {
		const args = p.check_args.length > 0 ? ` [${p.check_args.join(" ")}]` : "";
		lines.push(`  ${p.id} ${p.kind}${args}: ${p.goal}`, `     why: ${p.rationale} (proposed in ${p.proposed_in_step ?? "no step"})`);
	}
	lines.push("Accept with /accept-step <id> [start], or reject with /reject-step <id> [reason].");
	return lines.join("\n");
}

/** What changed in a plan's steps, for the person to decide whether to accept a hand edit. */
export function planDifference(before: Plan | undefined, after: Plan): string {
	if (!before) return `the plan now has ${after.steps.length} steps`;
	const changes: string[] = [];
	if (before.steps.length !== after.steps.length) changes.push(`steps: ${before.steps.length} -> ${after.steps.length}`);
	const old = new Map(before.steps.map((s) => [s.id, s]));
	const ids = new Set(after.steps.map((s) => s.id));
	for (const s of after.steps) {
		const o = old.get(s.id);
		if (!o) changes.push(`${s.id} added (${s.status})`);
		else if (o.status !== s.status) changes.push(`${s.id}: ${o.status} -> ${s.status}`);
	}
	for (const o of before.steps) if (!ids.has(o.id)) changes.push(`${o.id} removed (was ${o.status})`);
	return changes.length > 0 ? changes.join("; ") : "same steps and statuses; other fields changed";
}
