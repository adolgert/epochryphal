// The text the agent is shown for a step (plan Section 7.2). Identical in all three modes.
import type { Plan, Step } from "./plan.ts";

/** The user message that starts a step. */
export function stepPrompt(plan: Plan, step: Step, protectedPatterns: readonly string[]): string {
	const patterns = protectedPatterns.length > 0 ? protectedPatterns.join(", ") : "(none)";
	return [
		`[harness step ${step.id} | kind: ${step.kind} | plan: ${plan.plan_id}]`,
		`Epoch goal: ${plan.goal}`,
		`Step goal: ${step.goal}`,
		"You are finished only when the `submit` tool passes. If you cannot proceed, call",
		`\`report_blocked\` with the reason. Do not change files under: ${patterns}.`,
	].join("\n");
}

/** The line added to the system prompt of every run while a step is active. */
export function activeStepLine(step: Pick<Step, "id" | "goal">): string {
	const goal = /[.!?]$/.test(step.goal) ? step.goal : `${step.goal}.`;
	return `Active harness step ${step.id}: ${goal} Finish with submit or report_blocked.`;
}
