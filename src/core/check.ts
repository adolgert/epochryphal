// Running a step's check (plan Section 7.3): first the protected-file check, then the kind's check
// script under the script contract. The submit tool calls this; the headless runner will too.
import { join } from "node:path";
import type { Clock } from "./clock.ts";
import type { HarnessConfig } from "./config.ts";
import type { EventLog } from "./log.ts";
import type { Step } from "./plan.ts";
import { changedProtected, treeFingerprint } from "./protect.ts";
import { runScript } from "./script.ts";

export interface CheckRequest {
	root: string;
	harnessDir: string;
	config: HarnessConfig;
	plan: string;
	step: Pick<Step, "id" | "kind" | "attempt" | "check_args">;
	/** The commit recorded when the step started; null when it is not known. */
	baseCommit: string | null;
	by: "submit" | "runner";
	log: EventLog | null;
	signal?: AbortSignal;
	clock?: Clock;
}

/**
 * `failed` counts as a check attempt. `error` means the check could not run (a broken script, no
 * git, an unknown kind) and is not the agent's failure. `text` is what the agent is shown.
 */
export type CheckResult =
	| { status: "passed"; text: string; summary: string }
	| { status: "failed"; text: string; signature: string | null }
	| { status: "error"; text: string }
	| { status: "aborted"; text: string };

const brokenText = (problem: string) =>
	`The check itself is broken, so this does not count as a failed attempt: ${problem}\nCall report_blocked with this message so a person can fix the check.`;

export async function runCheck(req: CheckRequest): Promise<CheckResult> {
	const now = () => req.clock?.now() ?? Date.now();
	const start = now();
	const logCheck = (fields: { outcome: "result" | "script_error" | "aborted"; ok: boolean | null; signature: string | null; summary: string }) =>
		req.log?.write("check", { duration_ms: now() - start, by: req.by, ...fields, tree: fields.ok === false ? fingerprint() : null });
	// For the stall rule; a failure to compute it only means the tree half of that rule cannot trip.
	const fingerprint = (): string | null => {
		try {
			return treeFingerprint(req.root, req.baseCommit!, req.harnessDir);
		} catch {
			return null;
		}
	};
	const error = (problem: string): CheckResult => {
		logCheck({ outcome: "script_error", ok: null, signature: null, summary: problem });
		return { status: "error", text: brokenText(problem) };
	};

	const kind = req.config.kinds[req.step.kind];
	if (!kind) return error(`harness.json defines no kind "${req.step.kind}"`);
	if (req.baseCommit === null) return error(`no commit was recorded when step ${req.step.id} started, so protected files cannot be checked`);

	let changed: string[];
	try {
		changed = changedProtected(req.root, req.baseCommit, req.config.protected);
	} catch (e) {
		return error(`the protected-file check could not run: ${(e as Error).message}`);
	}
	if (changed.length > 0) {
		req.log?.write("protected_changed", { paths: changed });
		const summary = `protected files changed: ${changed.join(", ")}`;
		logCheck({ outcome: "result", ok: false, signature: "protected_changed", summary });
		return {
			status: "failed",
			signature: "protected_changed",
			text: `The check did not pass: ${summary}.\nRestore them to commit ${req.baseCommit.slice(0, 12)} (git checkout ${req.baseCommit.slice(0, 12)} -- <path>; delete new files), then call submit again. Files matching ${req.config.protected.join(", ")} must not change.`,
		};
	}

	const outcome = await runScript(
		[...kind.check, ...req.step.check_args],
		{ params: {}, plan: req.plan, step: req.step.id, attempt: req.step.attempt, kind: req.step.kind },
		{
			cwd: req.root,
			name: "check",
			timeoutMs: kind.check_timeout_s * 1000,
			maxSummaryChars: req.config.max_summary_chars,
			outputDir: join(req.root, req.harnessDir, "log", "outputs"),
			signal: req.signal,
			clock: req.clock,
		},
	);
	if (outcome.kind === "script_error") return error(outcome.text);
	if (outcome.kind === "aborted") {
		logCheck({ outcome: "aborted", ok: null, signature: null, summary: outcome.text });
		return { status: "aborted", text: outcome.text };
	}
	logCheck({ outcome: "result", ok: outcome.ok, signature: outcome.signature, summary: outcome.summary });
	if (outcome.ok) return { status: "passed", summary: outcome.summary, text: `The check passed: ${outcome.text}` };
	return { status: "failed", signature: outcome.signature, text: `The check did not pass:\n${outcome.text}\nKeep working, then call submit again.` };
}
