// The headless runner's loop for one step (plan Section 7.9), over a small session interface so it
// can be driven by a fake session in tests. The runner (src/runner/) supplies the real one.
import { feedbackPrompt } from "./prompt.ts";
import type { HeadlessRule } from "./rules.ts";

/** A check the runner ran. `ended` says the step is no longer active: it passed, or a stop rule ended it. */
export interface LoopCheck {
	status: "passed" | "failed" | "error" | "aborted";
	/** For a failed check, the bounded summary the feedback prompt shows; else what the check said. */
	summary: string;
	ended: boolean;
	/** The rule that stopped the step, when one did. */
	stopRule: string | null;
}

export interface LoopSession {
	/** Send a prompt and wait until the agent's run has settled. */
	prompt(text: string): Promise<void>;
	/** Whether the step is still active. False once it passed, was blocked, or was stopped. */
	active(): Promise<boolean>;
	/**
	 * Run the step's check (by "runner"). A pass marks the step passed; after a failure the stop
	 * rules for check attempts and stalls apply; a broken check stops the step with check_error.
	 */
	check(): Promise<LoopCheck>;
	/** End the active step as stopped by a headless-only rule. */
	stop(rule: HeadlessRule, why: string, value: number | null, limit: number | null): Promise<void>;
	/** harness-ctl stop was given. */
	stopRequested(): boolean;
}

/**
 * passed: the runner's check passed. ended: the step ended during the agent's run (submit,
 * report_blocked, or a stop rule); the event log says how. stopped: a stop rule ended it here.
 */
export type LoopResult = { how: "passed" } | { how: "ended" } | { how: "stopped"; rule: string };

/** Run one started step until it passes, ends, or uses up `maxIterations` prompts. */
export async function runStepLoop(s: LoopSession, step: { id: string; prompt: string }, maxIterations: number): Promise<LoopResult> {
	const stop = async (rule: HeadlessRule, why: string, value: number | null = null, limit: number | null = null): Promise<LoopResult> => {
		await s.stop(rule, why, value, limit);
		return { how: "stopped", rule };
	};
	const byUser = () => stop("aborted_by_user", "harness-ctl stop was given");
	let text = step.prompt;
	for (let i = 0; i < maxIterations; i++) {
		if (s.stopRequested()) return byUser();
		await s.prompt(text);
		if (!(await s.active())) return { how: "ended" };
		if (s.stopRequested()) return byUser();
		const c = await s.check();
		if (c.ended) return c.status === "passed" ? { how: "passed" } : c.stopRule ? { how: "stopped", rule: c.stopRule } : { how: "ended" };
		if (c.status === "passed") return { how: "ended" }; // Passed, but the step had ended meanwhile.
		if (s.stopRequested()) return byUser();
		// The session stops a broken check itself; this covers a check that ended neither way.
		if (c.status !== "failed") return stop("check_error", c.summary);
		text = feedbackPrompt(step.id, c.summary);
	}
	return stop("max_iterations", `${maxIterations} prompts without a pass`, maxIterations, maxIterations);
}
