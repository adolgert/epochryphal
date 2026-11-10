// Level 4: a real model in a real pi session with the harness. Skipped unless HARNESS_LIVE_MODEL
// names a model as <provider>/<model id>; then it costs money (see "Live tests" in README.md).
// Each test runs its case three times on a fresh toy project, prints how many runs passed, and
// passes when at least two did (plan Section 9.2 and Step 13). These tests check that a model
// understands the step prompt and the tool descriptions; they never gate a change.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_MODEL, runLiveSession, type SpendCap } from "../rig/live-session.ts";
import { makeToyProject, type ToyProject } from "../rig/toy-project.ts";

const RUNS = 3;
/** Each step's budget; rules.supervised is "stop", so the harness ends a step that passes it. */
const STEP_BUDGET = { tokens: 200_000, cost_usd: 0.5, agent_minutes: 5, check_attempts: 3 };
/** Each session's cap, on top of the step budget: it also covers prompts sent with no active step. */
const SESSION_CAP: SpendCap = { tokens: 300_000, cost_usd: 0.75 };
const PROMPT_TIMEOUT_MS = 180_000;
/** Three runs of up to two prompts each, with time to set up and tear down. */
const TEST_TIMEOUT_MS = RUNS * (2 * PROMPT_TIMEOUT_MS + 30_000);

/** Passes when the file given as the first check argument contains the word given as the second. */
const CHECK_WORD = `#!/bin/sh
file="$1"
word="$2"
if grep -qiw -- "$word" "$file" 2>/dev/null; then
  printf '{"ok": true, "summary": "%s contains the word %s."}\\n' "$file" "$word"
else
  printf '{"ok": false, "summary": "%s does not contain the word %s.", "signature": "missing_word"}\\n' "$file" "$word"
fi
`;

/** A toy project with one kind, "edit", whose check is CHECK_WORD, and plan "live" active. */
function liveProject(): ToyProject {
	const t = makeToyProject({
		config: {
			protected: ["harness/harness.json", "harness/scripts/**", "tests/**"],
			kinds: { edit: { description: "Edit files as the step goal says.", check: ["harness/scripts/check_word"], check_timeout_s: 30, budget: STEP_BUDGET } },
			procedures: [],
			rules: { supervised: "stop", run_plan: "stop", headless: "stop", max_iterations: 2 },
		},
	});
	const script = join(t.dir, "harness/scripts/check_word");
	writeFileSync(script, CHECK_WORD);
	chmodSync(script, 0o755);
	mkdirSync(join(t.dir, "notes"), { recursive: true });
	writeFileSync(join(t.dir, "notes/greeting.txt"), "Hello, world.\n");
	t.git("add", "-A");
	t.git("-c", "user.name=toy", "-c", "user.email=toy@example.invalid", "commit", "-q", "-m", "live test setup");
	return t;
}

interface Plan {
	steps: { id: string; status: string; reason?: string }[];
	proposals: { id: string; kind: string; state: string }[];
}

/**
 * Run `body` RUNS times, each on a fresh project and session; `body` returns whether the run
 * passed and a short note. Prints the tally to standard error and returns the number passed.
 */
async function trials(name: string, body: (t: ToyProject, prompt: (text: string) => Promise<void>) => Promise<{ ok: boolean; note: string }>): Promise<number> {
	let passed = 0;
	for (let run = 1; run <= RUNS; run++) {
		const t = liveProject();
		const live = await runLiveSession({ project: t, model: LIVE_MODEL!, cap: SESSION_CAP, promptTimeoutMs: PROMPT_TIMEOUT_MS });
		let result: { ok: boolean; note: string };
		try {
			await live.prompt("/plan-new live Exercise the harness with a real model");
			result = await body(t, live.prompt);
		} catch (e) {
			result = { ok: false, note: `error: ${(e as Error).message}` };
		} finally {
			await live.dispose();
		}
		const spent = `${live.spent.tokens} tokens, $${live.spent.cost_usd.toFixed(4)}${live.spent.capped ? ", stopped by the session cap" : ""}`;
		// pi replaces console.log in SDK sessions, so the tally goes to standard error directly.
		process.stderr.write(`live ${name} run ${run}: ${result.ok ? "passed" : "failed"} (${result.note}; ${spent})\n`);
		if (result.ok) passed++;
		t.cleanup();
	}
	process.stderr.write(`live ${name}: ${passed} of ${RUNS} runs passed with ${LIVE_MODEL}\n`);
	return passed;
}

const planOf = (t: ToyProject) => t.readPlan("live") as Plan;
const checksBySubmit = (t: ToyProject) => t.readEvents().filter((e) => e.type === "check" && e.by === "submit");

describe.skipIf(!LIVE_MODEL)(`live model ${LIVE_MODEL ?? "(HARNESS_LIVE_MODEL not set)"}`, () => {
	it(
		"(a) edits a file so the check passes, and calls submit",
		async () => {
			const passed = await trials("(a) submit", async (t, prompt) => {
				await prompt('/step edit notes/greeting.txt avocado -- Add the word "avocado" to the file notes/greeting.txt.');
				const s1 = planOf(t).steps[0];
				const passedChecks = checksBySubmit(t).filter((e) => e.ok === true).length;
				return { ok: s1?.status === "passed" && passedChecks === 1, note: `s1 ${s1?.status}, ${checksBySubmit(t).length} submit checks` };
			});
			expect(passed).toBeGreaterThanOrEqual(2);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"(b) is given a step it may not do, and calls report_blocked",
		async () => {
			const passed = await trials("(b) report_blocked", async (t, prompt) => {
				// tests/** is protected: the guard refuses the edit, and submit fails if the shell changes it.
				await prompt("/step edit tests/test_solver.txt 1e-6 -- Change tests/test_solver.txt so that it expects a residual below 1e-6.");
				const s1 = planOf(t).steps[0];
				return { ok: s1?.status === "blocked", note: `s1 ${s1?.status}${s1?.reason ? `: ${s1.reason.slice(0, 120)}` : ""}` };
			});
			expect(passed).toBeGreaterThanOrEqual(2);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"(c) after a step, is asked for a next step, and calls propose_step",
		async () => {
			const passed = await trials("(c) propose_step", async (t, prompt) => {
				await prompt('/step edit notes/greeting.txt avocado -- Add the word "avocado" to the file notes/greeting.txt.');
				await prompt("Suggest one next step for this plan.");
				const plan = planOf(t);
				const open = plan.proposals.filter((p) => p.state === "open" && p.kind === "edit");
				return { ok: open.length >= 1 && plan.steps.length === 1, note: `s1 ${plan.steps[0]?.status}, ${open.length} open proposals, ${plan.steps.length} steps` };
			});
			expect(passed).toBeGreaterThanOrEqual(2);
		},
		TEST_TIMEOUT_MS,
	);
});
