# Plan: a pi extension for supervised and unattended code-porting work

Prepared 9 November 2026 for Andrew Dolgert. This document is self-contained. An implementing agent (Claude Code) should be able to build the extension from this file alone, together with the documentation that ships inside the installed `pi` package.

---

## 1. How to use this plan

This section is addressed to the implementing agent.

1. **Work one step at a time.** Section 10 lists Steps 0 to 13. Finish a step, show the result, and stop. Do not start the next step until Andrew approves.
2. **Write the tests for a step first and show them.** Andrew reviews and edits the tests before the code is written. He then reviews the code for maintainability.
3. **Treat the installed pi package as the authority on pi's API.** This plan names pi functions and events. Those names were read from pi's public documentation on 9 November 2026 (Section 13). pi changes often. When this plan and the installed package disagree, the installed package wins, and you record the difference in `docs/pi-facts.md`. The installed package holds its own documentation under `node_modules/<scope>/pi-coding-agent/docs/` and example extensions under `examples/extensions/`.
4. **Do not invent pi API.** If a needed capability is not in the installed documentation or types, stop and say so.
5. **Keep the code small.** Target sizes are given per step. Add no runtime dependency beyond pi's own packages and `typebox`. Use `vitest` for tests. Use TypeScript in strict mode.
6. **Keep the layers separate** (Section 4). The core library must not import anything from pi.

---

## 2. Background

### 2.1 The work this extension supports

Andrew ports scientific codes to GPUs with the help of an AI coding agent. The first code is about 50,000 lines of Fortran 2008 that runs with MPI and OpenMP on CPUs. The port adds OpenMP target directives and must build with two compilers, NVIDIA's `nvfortran` and AMD's Fortran compiler. He plans to port about ten codes this way, so the extension must not contain anything specific to Fortran, to GPUs, or to one cluster.

The agent is `pi`, a small terminal coding agent that is designed to be extended. A pi extension is a TypeScript module that can register tools for the model, register slash commands for the person, and react to events such as "a tool is about to run."

Andrew works in **epochs**. An epoch has one goal, such as "port this routine to a GPU kernel" or "reduce TLB misses." Within an epoch he hands the agent small tasks one at a time, watches, and sometimes interrupts. He wants to keep working this way, add a light structure around it, and move gradually toward runs that need less supervision.

### 2.2 What the extension is for

The extension has four purposes.

- **Make "done" a checked fact.** The agent finishes a task by calling a tool that runs a check script. The agent's own claim of success counts for nothing.
- **Record what happened.** Every tool call, model call, typed message, and check result goes into a log. The log answers "what did the agent do, what did it cost, and where did it need help."
- **Measure which changes help.** Andrew will change tools, context files, and stored lessons over time. Completion rates and interruption counts, taken from the log, show whether a change helped.
- **Allow less supervision when it is earned.** The same code runs a single supervised step, a sequence of steps with approval between them, and a fully unattended run.

### 2.3 Lessons that shape the design

These points come from Andrew's earlier attempts and from discussion. They explain choices made below.

- **The work cannot be planned far ahead.** His manual loop is: look at a profile, try something, look at the profile again. The next step depends on the last result. The plan file is therefore a **rolling plan** that holds only the next few steps.
- **A step can end without success and still be finished.** An attempt may turn out slower, or impossible. "Abandoned, with a reason" is a normal ending.
- **Ceremony must be low.** Starting a step must cost one typed line, close to how he hands out tasks today.
- **Nobody can write a custom acceptance script before every step.** Each step instead has a **kind**, and each kind has one standard check.
- **An earlier harness had a strong security boundary and was slow to change.** This extension detects tampering with tests but does not try to prevent it by isolation.

### 2.4 Terms

| Term | Meaning |
|---|---|
| Project | The working directory of the code being ported. It is a git repository. |
| Plan | A JSON file for one epoch: a goal, a short list of steps, and a closing decision. |
| Step | One small task given to the agent. It has a kind, a goal, and a status. |
| Kind | A category of step. Each kind names the check script that decides whether a step of that kind passed. |
| Check | A project script that the extension runs to decide whether a step passed. |
| Procedure | Any other project script exposed to the agent as a tool, such as build or profile. |
| Interruption | A message the person types, or an abort the person triggers, while a step is active. |
| Proposal | A step suggested by the agent. It becomes a step only when the person accepts it. |
| Stop rule | A condition under which the extension ends a step itself, such as a spent budget. |
| Lesson | A short stored note about a past failure, shown to the agent when the same error text appears again. |

---

## 3. Scope

### 3.1 In scope

- The extension package: plan handling, completion tools, procedure tools, proposals, logging, interruption tracking, budgets and stop rules, the multi-step runner inside pi, the lesson hook.
- A headless runner program that drives the same extension through pi's SDK.
- A report command that computes metrics from the logs.
- The **contract** between the extension and project scripts (Section 6).
- **Fake** scripts and a **scripted fake model** for tests (Section 9).

### 3.2 Out of scope

These are separate pieces of work. The extension only defines how it calls them.

- Real build, test, profile, job-submission, and offload-check scripts for any cluster or compiler.
- The regression tests for the Fortran code.
- The static-analysis tool that reports the effects of a call site. When it exists, it is exposed as one more procedure in the configuration file, with no new extension code.
- A directory of vendor documentation. It needs one line in the project's context file and no extension code.
- Any gateway, ledger, or container boundary.
- Controlled experiments that compare configurations statistically. The headless runner makes them possible later.

---

## 4. Architecture

The code has three layers. The split exists so that most behavior can be tested as plain functions, and so that the supervised and unattended modes cannot drift apart.

```
src/
  core/        Plain TypeScript. No pi imports. Uses only Node's standard library.
               Plan store, script runner, check logic, protected-file check,
               budget, stall detection, event log, lessons, report.
  extension/   Thin adapter. Binds core functions to pi events, tools, and commands.
  runner/      Thin SDK program. Loads the extension and runs a plan with nobody present.
  bin/         Command-line entry points: harness-run, harness-ctl, harness-report.
test/
  unit/        Level 1 tests (core functions, adapter with a stub pi).
  sdk/         Level 2 tests (real pi runtime in-process, scripted model).
  cli/         Level 3 tests (the pi executable as a subprocess).
  live/        Level 4 tests (a real model; opt-in).
  rig/         Shared test helpers: scripted model, toy project, stub pi, CLI driver.
docs/
  pi-facts.md  What Step 0 found out about the installed pi version.
```

**Rule:** a behavior is written once, in `core/`. The extension and the runner call it. If the runner needs to run a check, it calls the same function that the `submit` tool calls.

The package lives in its own git repository, separate from any code being ported. It is loaded into pi with `pi -e /path/to/package` during development, and later through the `extensions` list in the project's `.pi/settings.json`.

---

## 5. Files in the project

The extension reads and writes these paths inside the project. All paths are relative to the project root. The directory name `harness/` can be changed with one configuration value.

```
harness/
  harness.json           Configuration, written by a person.
  plans/<plan_id>.json   One plan per epoch.
  plans/ACTIVE           One line: the plan_id of the active plan.
  scripts/               Project scripts: check and procedures. Written by a person.
  lessons/*.md           Approved lessons.
  lessons/drafts/*.md    Lesson drafts awaiting a person's approval.
  log/events.jsonl       Every event. Append-only. Ignored by git.
  log/steps.jsonl        One record per finished step attempt. Append-only. Ignored by git.
  log/outputs/           Full output of each script call. Ignored by git.
  log/control.jsonl      Commands sent to a headless run. Ignored by git.
```

### 5.1 Configuration: `harness/harness.json`

```json
{
  "version": 1,
  "max_summary_chars": 2000,
  "protected": ["harness/harness.json", "harness/scripts/**", "harness/lessons/**", "tests/**"],
  "kinds": {
    "restructure": {
      "description": "Change code structure with no change in results.",
      "check": ["harness/scripts/check", "restructure"],
      "check_timeout_s": 1800,
      "budget": { "tokens": 1500000, "cost_usd": 20, "agent_minutes": 60, "check_attempts": 5 }
    },
    "offload": {
      "description": "Move a region to the GPU.",
      "check": ["harness/scripts/check", "offload"],
      "check_timeout_s": 3600,
      "budget": { "tokens": 2000000, "cost_usd": 30, "agent_minutes": 90, "check_attempts": 5 }
    },
    "measure": {
      "description": "Record a profile and a short note. No threshold.",
      "check": ["harness/scripts/check", "measure"],
      "check_timeout_s": 3600,
      "budget": { "tokens": 500000, "cost_usd": 8, "agent_minutes": 30, "check_attempts": 3 }
    }
  },
  "procedures": [
    {
      "name": "build",
      "description": "Build the code. Use after any source change.",
      "command": ["harness/scripts/build"],
      "params": { "variant": { "type": "string", "enum": ["cpu", "gpu"], "description": "Which build." } },
      "timeout_s": 1800,
      "is_wait": false,
      "requires": [],
      "lesson_trigger": true
    },
    {
      "name": "run_sample",
      "description": "Run the small sample workload on the current build.",
      "command": ["harness/scripts/run_sample"],
      "params": {},
      "timeout_s": 1800,
      "is_wait": false,
      "requires": ["build"],
      "lesson_trigger": true
    },
    {
      "name": "wait_for_job",
      "description": "Wait for a queued job to finish.",
      "command": ["harness/scripts/wait_for_job"],
      "params": { "job_id": { "type": "string", "description": "Job id from submit_job." } },
      "timeout_s": 14400,
      "is_wait": true,
      "requires": [],
      "lesson_trigger": false
    }
  ],
  "rules": {
    "supervised": "warn",
    "run_plan": "stop",
    "headless": "stop",
    "max_iterations": 3
  },
  "run_plan": { "approve": "ask" },
  "headless": { "session_mode": "fresh_per_step" },
  "lessons": { "max_per_result": 2, "max_chars": 1500 }
}
```

Notes on the fields:

- `kinds` is open. A project may define any kinds it wants. The three above are the starting set for the Fortran port.
- `protected` is a list of glob patterns for files the agent must not change. The plan files and the `log/` directory are handled separately (Section 7.4).
- `is_wait` marks a procedure whose running time is waiting, such as time in a job queue. Waiting time is not charged to the step's `agent_minutes`.
- `requires` lists procedures that must have succeeded earlier in the same step, with no file edit by the agent since then.
- `rules` says what a tripped stop rule does in each mode: `warn` tells the person and logs it; `stop` ends the step.

### 5.2 Plan file: `harness/plans/<plan_id>.json`

```json
{
  "plan_id": "epoch-12-tridiag-offload",
  "goal": "Run the tridiagonal solve on the GPU with arrays kept on the device.",
  "created_at": "2026-11-10T14:02:11Z",
  "steps": [
    {
      "id": "s1",
      "kind": "measure",
      "goal": "Profile the sample workload and record the top five routines.",
      "check_args": [],
      "origin": "user",
      "status": "passed",
      "attempt": 1
    },
    {
      "id": "s2",
      "kind": "offload",
      "goal": "Port region R17 to an OpenMP target region.",
      "check_args": ["R17"],
      "origin": "proposal:p1",
      "status": "active",
      "attempt": 1,
      "budget": { "tokens": 3000000 }
    }
  ],
  "proposals": [
    {
      "id": "p2",
      "kind": "offload",
      "goal": "Keep R17 and R18 arrays on the device between calls.",
      "check_args": ["R17", "R18"],
      "rationale": "The profile shows repeated host-to-device copies of the same arrays.",
      "proposed_in_step": "s2",
      "state": "open"
    }
  ],
  "exit": null
}
```

- A step's `status` is one of `pending`, `active`, `passed`, `blocked`, `abandoned`, `stopped`.
- At most one step is `active` at a time.
- A step's optional `budget` overrides single fields of its kind's budget.
- A proposal's `state` is `open`, `accepted`, or `rejected`.
- `exit` is filled when the epoch is closed: `{ "decision": "keep" | "revert" | "continue", "note": "...", "at": "..." }`.
- The file is JSON because a person and a program both edit it, and JSON is unambiguous to parse.

### 5.3 Event log: `harness/log/events.jsonl`

One JSON object per line. Every record has these fields:

```json
{ "ts": "2026-11-10T14:05:09.120Z", "session": "<pi session id or file>", "mode": "supervised",
  "plan": "epoch-12-tridiag-offload", "step": "s2", "attempt": 1, "type": "tool_call", "...": "..." }
```

`plan`, `step`, and `attempt` are null when no step is active. `mode` is `supervised`, `run_plan`, or `headless`.

Event types and their extra fields:

| `type` | Extra fields |
|---|---|
| `session_start`, `session_end` | `reason` |
| `step_start` | `kind`, `goal`, `origin` |
| `step_end` | `outcome` (Section 5.4), `detail` |
| `model_call` | `model`, `input`, `output`, `cache_read`, `cache_write`, `total_tokens`, `cost_usd`, `stop_reason` |
| `tool_call` | `tool`, `args_summary` (first 200 characters), `duration_ms`, `is_error` |
| `script` | `name`, `ok`, `signature`, `duration_ms`, `timed_out`, `output_path` |
| `check` | `ok`, `signature`, `summary`, `duration_ms`, `by` (`submit` or `runner`) |
| `interruption` | `how` (`steer`, `follow_up`, `idle_message`, `abort`, `control`), `text_head` (first 200 characters), `reason`, `note` |
| `guard_block` | `tool`, `path` |
| `protected_changed` | `paths` |
| `plan_changed_externally` | `plan` |
| `rule_tripped` | `rule`, `action` (`warn` or `stop`), `value`, `limit` |
| `proposal` | `proposal_id`, `action` (`proposed`, `accepted`, `rejected`) |
| `lesson_injected` | `lesson_id`, `tool` |
| `lesson_drafted` | `path` |

### 5.4 Step log: `harness/log/steps.jsonl`

One record is written each time a step attempt ends. This file is what the metrics read.

```json
{ "ts": "2026-11-10T15:11:40Z", "plan": "epoch-12-tridiag-offload", "step": "s2", "attempt": 1,
  "kind": "offload", "origin": "proposal:p1", "mode": "supervised",
  "outcome": "passed", "stop_rule": null, "reason": null,
  "interruptions": 2, "interruptions_by_reason": { "missing-info": 1, "unlabeled": 1 },
  "check_attempts": 3, "script_failures": 4,
  "tokens": 812345, "cost_usd": 9.41, "agent_minutes": 38.2, "wait_minutes": 12.0, "model_calls": 61 }
```

`outcome` is one of:

- `passed`: the check passed.
- `blocked`: the agent called `report_blocked`.
- `abandoned`: the person ended the step with `/abandon`.
- `stopped`: a stop rule ended the step. `stop_rule` names it.

---

## 6. The script contract

The extension calls every project script the same way. Checks and procedures share this contract.

**Call.**

- The extension runs the configured `command` array as a process, without a shell. For a check, the step's `check_args` are appended to the array.
- The working directory is the project root.
- Standard input receives one JSON object: `{ "params": { ... }, "plan": "...", "step": "...", "attempt": 1, "kind": "..." }`. For a check, `params` is empty.
- The same values are also set as environment variables `HARNESS_PLAN`, `HARNESS_STEP`, `HARNESS_ATTEMPT`, `HARNESS_KIND`.

**Result.**

- The script writes exactly one JSON object as the **last line** of standard output. Earlier lines are free-form.
- The object has these fields:

```json
{ "ok": true,
  "summary": "Short text for the agent. At most a few lines.",
  "signature": "optional short string that identifies this kind of failure",
  "details_path": "optional path to a longer report",
  "data": { "optional": "structured values for the log" } }
```

- Exit code 0 means the script ran. `ok` then says whether the result is success or failure.
- A nonzero exit code, or a last line that is not valid JSON, means the script itself is broken. The extension reports this as a **script error**, which is different from a failed result. A script error on a check never counts as a failed attempt by the agent.

**Bounds.**

- The extension saves all standard output and standard error to `harness/log/outputs/<timestamp>-<name>.txt`.
- The text returned to the agent is the `summary`, cut to `max_summary_chars`. When text is cut, the returned text ends with a line that states how many characters were removed and gives the path of the full output.

**Time limits and aborts.**

- Each call has a time limit. When the limit passes, or when the run is aborted, the extension sends a terminate signal to the process, waits five seconds, and then kills it.
- A script that submits queued jobs must cancel them when it receives the terminate signal. The extension does not know about schedulers.
- A call that hits its limit returns `ok: false` with the summary `timed out after N minutes` and the signature `timeout`.

---

## 7. Behavior of the extension

### 7.1 Commands for the person

| Command | Effect |
|---|---|
| `/plan-new <plan_id> <goal text>` | Creates a plan file and makes it the active plan. |
| `/plan-use <plan_id>` | Makes an existing plan the active plan. |
| `/plan-status` | Shows the goal, each step with its status, open proposals, and the active step's usage against its budget. |
| `/plan-close <keep\|revert\|continue> <note>` | Records the closing decision in `exit`. Refused while a step is active. |
| `/step <kind> [check args...] -- <goal text>` | Appends a step and starts it at once. Without `--`, all text after the kind is the goal and there are no check arguments. |
| `/add-step <kind> [check args...] -- <goal text>` | Appends a step without starting it. |
| `/next-step` | Starts the first `pending` step. |
| `/retry-step [step_id]` | Sets a `blocked`, `abandoned`, or `stopped` step back to `active` with the attempt number raised by one, and starts it. |
| `/abandon <reason>` | Ends the active step as `abandoned`. |
| `/proposals` | Lists open proposals. |
| `/accept-step <proposal_id> [start]` | Turns a proposal into a `pending` step. With `start`, also starts it. |
| `/reject-step <proposal_id> [reason]` | Marks a proposal `rejected`. |
| `/why <reason> [note]` | Attaches a reason to the most recent interruption. `reason` is one of `wrong-direction`, `missing-info`, `environment`, `too-slow`, `other`. |
| `/run-plan [n]` | Runs up to `n` pending steps in sequence (default: all), pausing at each step boundary. |
| `/stop-plan` | Ends `/run-plan` mode after the current step. |

A command that starts a step is refused when another step is active or when the agent is busy.

### 7.2 Starting a step

When a step starts, the extension does four things.

1. It sets the step's status to `active` and writes the plan file.
2. It records the current git commit and the state of the protected files (Section 7.4).
3. It writes a `step_start` event.
4. It sends the agent a user message built from a fixed template:

```
[harness step <id> | kind: <kind> | plan: <plan_id>]
Epoch goal: <plan goal>
Step goal: <step goal>
You are finished only when the `submit` tool passes. If you cannot proceed, call
`report_blocked` with the reason. Do not change files under: <protected patterns>.
```

While a step is active, the extension also adds one line to the system prompt of every agent run: `Active harness step <id>: <goal>. Finish with submit or report_blocked.` This line survives context compaction and session restarts.

The template text lives in one place in `core/` and is identical in all three modes.

### 7.3 Tools for the agent

**`submit({ note?: string })`.** The agent calls this when it believes the step is complete. The tool:

1. Refuses when no step is active.
2. Runs the protected-file check (Section 7.4). If protected files changed, it returns a failure that lists them and asks the agent to restore them. This counts as a check attempt with the signature `protected_changed`.
3. Runs the kind's check script through the script contract.
4. Writes a `check` event.
5. On `ok: true`: sets the step to `passed`, writes the `step_end` event and the step record, and returns the summary with the flag that ends the agent's run.
6. On `ok: false`: returns the summary. Then it applies the stop rules for check attempts and stalls (Section 7.7).
7. On a script error: returns a message that says the check itself is broken and that the agent should call `report_blocked`.

**`report_blocked({ reason: string })`.** Sets the step to `blocked`, records the reason, writes the step record, and ends the agent's run.

**`propose_step({ kind, goal, check_args?, rationale })`.** Adds a proposal to the plan file. It never creates a step. The tool refuses an unknown kind. At most ten open proposals may exist; beyond that the tool refuses and says so.

**Procedure tools.** At load time the extension registers one tool for each entry in `procedures`. The tool's name, description, and parameter schema come from the configuration. Calling the tool:

1. Checks `requires`. If a required procedure has not succeeded in this step since the agent's last file edit, the tool refuses and names the missing procedure. "File edit" here means a call to pi's built-in `edit` or `write` tool. Edits made through the shell are not seen; the real scripts remain the final authority on staleness.
2. Runs the script through the script contract.
3. Writes a `script` event.
4. Returns the bounded summary. A result with `ok: false` is returned as a tool error.

Procedure tools work with or without an active step. Without one, the events carry a null step.

### 7.4 Protecting the tests and the plan

The agent has a shell. It can change any file the person can change. The extension therefore **detects** forbidden changes and does not claim to prevent them. This is a stated limit.

- **Guard.** A handler on pi's `tool_call` event blocks calls to the built-in `edit` and `write` tools whose target path matches a `protected` pattern or lies under `harness/plans/` or `harness/log/`. The block returns a reason the agent can read. A `guard_block` event is written.
- **Protected-file check.** When a step starts, the extension records the current commit. At each `submit`, it asks git two questions about the protected patterns: which files differ from the recorded commit, and which files are modified or untracked in the working tree. Any answer other than "none" fails the check with the list of files. A step cannot start while protected files have uncommitted changes; the command says which files.
- **Plan file.** The extension remembers a hash of the plan file after each of its own writes. Before each read it compares. A mismatch means someone else edited the file. A person editing the plan by hand is legitimate, so in a session with a user interface the extension shows the difference in step count and statuses and asks whether to accept it. In a headless run a mismatch ends the run with the stop rule `plan_changed_externally`.

### 7.5 Logging

The extension writes the events of Section 5.3 from these pi events:

- `session_start`, `session_shutdown`
- `tool_execution_start` and `tool_execution_end`, joined by tool call id, for `tool_call` records
- `message_end` for assistant messages, for `model_call` records with token usage and cost
- `input`, for interruptions (Section 7.6)
- `agent_settled`, for aborts and for step-boundary logic

A failure to write a log line must never break the agent's work. The logger catches its own errors, reports the first one to the person, and continues.

### 7.6 Interruptions

An interruption is recorded when a step is active and one of these happens:

- The person types a message while the agent is working. pi's `input` event reports whether the message steers the current run or is queued as a follow-up. `how` is `steer` or `follow_up`.
- The person types a message while the agent is idle and the step is still active. `how` is `idle_message`.
- The person aborts the agent's run. `how` is `abort`.
- A headless run receives a steering message through the control file. `how` is `control`.

Messages that the extension itself sends, such as the step prompt, are not interruptions. pi's `input` event carries a `source` field; only messages whose source is the person count. Slash commands are not interruptions.

`/why <reason> [note]` attaches a reason to the most recent interruption of the active step by writing a second `interruption` record that refers to the first. Interruptions with no reason are counted as `unlabeled`. Labeling is optional by design.

### 7.7 Budgets and stop rules

pi's documentation, as read for this plan, describes no built-in limit on tokens, turns, cost, or time. The extension supplies them.

A **budget tracker** exists for the active step. It adds up:

- tokens and cost, from each assistant message's usage record;
- agent minutes, as wall-clock time since the step started minus time spent inside procedures marked `is_wait`;
- check attempts, as the number of `submit` calls that ran a check.

The stop rules are:

| Rule | Trips when |
|---|---|
| `budget_tokens`, `budget_cost`, `budget_minutes` | The tracker exceeds the step's budget. Checked after every model call. |
| `max_check_attempts` | The number of failed checks reaches the budget's `check_attempts`. |
| `stall` | Two consecutive failed checks have the same non-empty `signature`, or the working tree is byte-for-byte unchanged between two consecutive failed checks. |
| `check_error` | The check script itself is broken. Headless mode only; in other modes the agent is told to call `report_blocked`. |
| `max_iterations` | Headless mode only (Section 7.9). |
| `plan_changed_externally` | Headless mode only (Section 7.4). |

What a tripped rule does depends on the mode, as set in `rules`:

- `warn`: the person sees a notice, and a `rule_tripped` event is written. Work continues. This is the default for supervised steps, because the person is watching.
- `stop`: the step's status becomes `stopped`, the step record is written with the rule's name, further tool calls in the run are blocked with a reason, and the run ends.

A budget check runs after a model call, so the last call can exceed the limit. This is accepted. The actual usage is what gets recorded.

### 7.8 Running several steps: `/run-plan`

`/run-plan [n]` puts the session in `run_plan` mode. In this mode:

1. The extension starts the first pending step.
2. When the agent's run has fully settled, the extension looks at the step's status.
3. If the step `passed` and another pending step exists, the extension shows a boundary summary: the step's goal, the check summary, tokens and cost used, and the next step's goal. With `"approve": "ask"` it asks the person to choose **continue**, **stop**, or **stop and edit**. With `"approve": "auto"` it continues.
4. On continue, it starts the next step.
5. If the step ended any other way, or the agent stopped without calling `submit` or `report_blocked`, the mode ends and the person is told why.

Stop rules act with the `run_plan` setting, which is `stop` by default.

A continuation happens only directly after a step has passed. This condition is what prevents an endless loop. pi's documentation warns that an unconditional continuation request is evaluated again after the next response.

Step 0 decides which pi mechanism starts the next step (Section 10, fact 7).

### 7.9 The headless runner

`harness-run` is a small program that uses pi's SDK. It loads the extension, takes a plan, and runs pending steps with nobody present.

```
harness-run --project <dir> --plan <plan_id> --model <provider/id>
            [--steps <n>] [--session-mode fresh_per_step|continue]
```

For each pending step, in order:

```
start the step                          (same core function as /next-step)
repeat up to rules.max_iterations times:
    send the step prompt, or after a failed check the feedback prompt
    wait until the agent's run has settled
    if the step is no longer active: leave the loop     (passed, blocked, or stopped)
    run the check                       (same core function as the submit tool; by = "runner")
    if it passed: mark the step passed; leave the loop
    apply the stop rules; if one tripped: leave the loop
if the step is still active: mark it stopped with rule max_iterations
if the step did not pass: end the whole run
```

The feedback prompt is a fixed template that contains only the check summary:

```
The check for step <id> did not pass:
<summary>
Continue working. Call `submit` when the step is complete, or `report_blocked` if you cannot proceed.
```

Other properties of the runner:

- **Sessions are saved to files**, so a finished or stopped run can be opened in pi's interactive interface and continued by hand.
- **`fresh_per_step`** creates a new pi session for each step. The plan file and the logs carry state forward. `continue` keeps one session for the whole run.
- **Live feed.** The runner prints one line per event to standard output as events are logged: time, step, type, and a short description, with a running token and cost total.
- **Control file.** The runner watches `harness/log/control.jsonl`. `harness-ctl steer "<text>"` appends a steering message, which the runner passes to the session and logs as an interruption. `harness-ctl stop` aborts the run and marks the active step `stopped` with the rule `aborted_by_user`.
- **Exit code.** 0 when every attempted step passed, 2 when a step ended any other way, 1 on a program error.
- **No approval prompts.** The runner never asks a question. Any code path that would ask the person must check whether a user interface exists and take the non-interactive branch.

### 7.10 Lessons

A lesson is a Markdown file in `harness/lessons/` with a short header:

```markdown
---
id: nvfortran-target-data-derived-type
pattern: "NVFORTRAN-S-0155.*derived type"
tools: [build]
compiler: nvfortran 25.9
machine: cluster-a
date: 2026-11-03
evidence: "epoch-11 step s4, commits 3f2a1c..9be0d2"
---
Cause: one or two lines.
Workaround: one or two lines.
```

- **Loading.** Lessons are read once when the session starts and do not change during the session. A run therefore always sees a fixed set.
- **Injection.** A handler on pi's `tool_result` event looks at failed results of procedure tools that have `lesson_trigger: true`. It tests each lesson whose `tools` list contains the tool against the result text, using the lesson's `pattern` as a regular expression. Up to `max_per_result` matching lessons are appended to the result, each introduced by `[lesson <id>]`, within `max_chars` in total. A `lesson_injected` event is written for each.
- **Drafting.** When a step ends as `passed`, the extension scans that step's events. For each procedure failure that was later followed by a success of the same procedure, it writes a draft to `harness/lessons/drafts/`. The draft contains the header with `pattern` left empty, the first 40 lines of the failing output, the step id, and the commit range. `Cause` and `Workaround` are left for a person to fill in, or for the agent to fill in when a person asks. A draft has no effect until a person moves it into `harness/lessons/`.
- **No model calls.** The extension itself never calls a model.

### 7.11 The report

`harness-report --project <dir> [--plan <plan_id>] [--since <date>] [--format md|csv]` reads `steps.jsonl` and prints:

- **Per kind:** number of step attempts; counts of `passed`, `blocked`, `abandoned`, `stopped`; completion rate, which is passed attempts divided by all attempts; unaided rate, which is passed attempts with zero interruptions divided by all attempts; median tokens, cost, agent minutes, and check attempts.
- **Interruptions:** counts by reason and by kind.
- **Stop rules:** counts by rule.
- **Per plan:** number of steps; number of steps that came from proposals; proposals accepted and rejected; the closing decision.

Completion rate is reported per step and per kind. A plan-level completion rate is deliberately not computed, because a rolling plan changes by design and an epoch can end correctly with the decision `revert`.

---

## 8. State across restarts

- The plan file and the logs on disk are the source of truth. The extension keeps no state that cannot be rebuilt from them.
- On `session_start`, the extension reads the active plan. If a step is `active`, it rebuilds the budget tracker and interruption count for that step by reading `events.jsonl`.
- State that is needed only within a session, such as which procedures have succeeded since the last edit, is rebuilt the same way or starts empty.

---

## 9. Testing

Testing has four levels. Each behavior is tested at the lowest level that can show it. The higher levels exist to prove that the wiring to pi is real.

| Level | What runs | Model | Speed | Purpose |
|---|---|---|---|---|
| 1 | TypeScript functions, called directly | none | milliseconds | All logic in `core/`; adapter wiring against a stub of pi's API |
| 2 | Real pi runtime in-process, through the SDK | scripted | about a second | Events fire, tools and commands are registered and behave, state persists |
| 3 | The `pi` executable as a subprocess | scripted | seconds | Loading from a path, command-line flags, JSON output, session files |
| 4 | Level 2 or 3 with a real model | real | minutes, costs money | Tool descriptions and the step prompt are understandable to a model |

Levels 1 to 3 run with `npm test`, need no network, and cost nothing. Level 4 runs only when the environment variable `HARNESS_LIVE_MODEL` names a model.

### 9.1 The test rig

Step 1 builds these helpers in `test/rig/`. Every later step uses them.

**Scripted model.** A fake model that replays a script, so tests are exact and free. The script is a JSON file:

```json
[
  { "tool": "build", "args": { "variant": "gpu" } },
  { "tool": "submit", "args": {} },
  { "text": "The step is complete." }
]
```

- Each entry is one model response: a tool call, several tool calls, or text.
- Entries are used in order. When the script runs out, the model answers `SCRIPT_EXHAUSTED`, and the test helper fails the test.
- The scripted model writes every request it receives (system prompt and messages) to a file. Tests read that file to assert what the model was shown, such as the step prompt or an appended lesson.
- Each response reports fixed usage numbers, for example 100 input and 10 output tokens, so that budget tests are exact.
- The script path comes from the environment variable `HARNESS_TEST_SCRIPT`, so the same scripted model works in-process and in a subprocess.

Step 0 chooses how the scripted model is built. The options, in order of preference:

1. A test provider shipped inside pi's own AI package, if the installed version has one. Search the installed package for `faux`.
2. A small extension of our own that calls `pi.registerProvider` with a custom streaming function. pi's custom-provider documentation lists the requirements for such a function.
3. A third-party test harness for pi extensions. Two exist as of this writing, `pi-test-harness` and `pi-mock`. Use one only if options 1 and 2 fail, because it adds a dependency that must track pi's releases.

**Fake scripts.** One program, `test/rig/fake-script.mjs`, stands in for every project script. A behavior file tells it what to return:

```json
{
  "check": [
    { "ok": false, "summary": "2 tests failed", "signature": "T1,T2" },
    { "ok": true, "summary": "all tests pass" }
  ],
  "build": [ { "ok": false, "summary": "NVFORTRAN-S-0155: derived type not allowed" }, { "ok": true, "summary": "built" } ],
  "run_sample": [ { "mode": "hang" } ],
  "profile": [ { "mode": "garbage" } ],
  "broken": [ { "mode": "exit", "code": 3 } ]
}
```

- Each call consumes the next entry for that script name. A counter file keeps the position between calls. The last entry repeats.
- Special modes: `hang` sleeps until killed, for time-limit tests; `garbage` prints text that is not JSON; `exit` leaves with a nonzero code; `big` prints a very long summary.
- The fake script appends each call's standard input to a record file, so tests can assert what the extension passed.

**Toy project.** `makeToyProject(options)` creates a temporary directory with `git init`, two small source files, a `harness/harness.json` whose kinds and procedures point at the fake script, and one commit. No Fortran is involved. It returns the path and helpers to read the plan file and the logs.

**Stub of pi's API.** `FakePi` is a hand-written object with the methods the extension uses: `on`, `registerTool`, `registerCommand`, `sendUserMessage`, and the others the adapter calls. It records registrations. A test can fire an event, call a registered tool's `execute`, or call a command's handler, each with a stub context whose user-interface answers are scripted. The stub imports pi's **types** only, so the TypeScript compiler reports when pi's real API has moved away from the stub.

**SDK helper.** `runSdkSession({ script, project, config })` creates a real pi session in-process with an in-memory session store, loads the extension and the scripted model through the SDK's resource loader, and returns the session together with the toy project's helpers.

**CLI helper.** `runPiCli({ args, script, project })` starts the `pi` executable with:

```
pi --no-extensions -e <extension path> -e <scripted model path>
   --model <scripted model id> --mode json
   --no-context-files --no-skills --no-prompt-templates --offline
   [--no-session | --session-dir <temp dir>]  "<prompt>"
```

It sets pi's configuration directory to a temporary directory so the developer's own settings and extensions cannot affect the test. It parses the JSON lines from standard output and returns them with the exit code.

**Clock.** Core functions that read the time take a clock argument. Tests pass a fake clock.

### 9.2 Rules for tests

- **One drift test per pi event.** For every pi event name the extension subscribes to, one level 2 test asserts that the handler ran. These tests are tagged `drift`. They are run after every pi upgrade, before anything else.
- **The pi version is pinned exactly** in `package.json`. An upgrade is a deliberate change with its own review.
- **`tsc --noEmit` is part of `npm test`.**
- **No test depends on timing.** Time limits are tested with a `hang` fake and a limit of a few hundred milliseconds.
- **Level 3 tests are few.** Each takes seconds. Add one only for something that levels 1 and 2 cannot show.
- **The interactive terminal interface is not tested automatically.** Each step lists a short manual check instead. Dialogs can be reached through pi's RPC mode, where pi's documentation says dialogs are routed through JSON; Step 0 records whether that is practical.
- **Level 4 tests never gate a change.** Each live test runs three times and reports how many runs passed.

### 9.3 Which behavior is tested where

| Behavior | L1 | L2 | L3 | Manual |
|---|---|---|---|---|
| Script contract: parse, bound, time limit, abort, script error | ✔ | | | |
| Plan store: create, append, status changes, hash check | ✔ | | | |
| Protected-file check with git | ✔ | | | |
| Budget tracker, stall detection, stop-rule decisions | ✔ | | | |
| Lesson matching and bounding | ✔ | | | |
| Report numbers from a fixed `steps.jsonl` | ✔ | | | |
| Command parsing (`/step offload R17 -- goal`) | ✔ | | | |
| Adapter wiring: each tool and command calls the right core function | ✔ (stub) | | | |
| `submit` passes: status changes, run ends | | ✔ | | |
| `submit` fails, then passes | | ✔ | | |
| Guard blocks a built-in `edit` to a protected file | | ✔ | | |
| Step prompt and system-prompt line reach the model | | ✔ | | |
| Events are logged with usage and cost | | ✔ | | |
| Interruption recorded for a steering message | | ✔ | | ✔ |
| State restored after a session restart | | ✔ | ✔ | |
| `/run-plan` advances only after a pass | | ✔ | | ✔ |
| Extension loads from a path with `-e` | | | ✔ | |
| A slash command works when given as the prompt | | | ✔ | |
| Headless runner end to end, exit codes | | ✔ | ✔ | |
| Dialogs and notices look right | | | | ✔ |

---

## 10. Implementation steps

Every step ends with a stop for review. "Done when" lists what Andrew checks. Target sizes are for non-test code.

**Usable milestones:** after Step 6 the extension supports real supervised work with metrics. After Step 10 it supports multi-step runs. After Step 11 it supports unattended runs.

### Step 0. Establish the facts about the installed pi

**Goal.** Replace assumptions with tested facts before any design depends on them.

**Do.** Install pi at one exact version. For each item below, read the installed documentation and types, then write a throwaway probe of a few lines where reading is not enough. Record each answer, with the pi version and how it was verified, in `docs/pi-facts.md`.

| # | Question | What the public documentation said on 9 Nov 2026 |
|---|---|---|
| 1 | What is the package name and scope to import from? | Current docs use `@earendil-works/pi-coding-agent`. Older releases used `@mariozechner/pi-coding-agent`. |
| 2 | Does `--no-extensions` keep extensions given with `-e`? | Yes. |
| 3 | Do extension slash commands run when given as the prompt in print or JSON mode? | Not stated for the command line. The SDK page says extension commands run through `session.prompt()`. |
| 4 | Does the `input` event fire for a message typed during a run, and what are its fields? | The event has `text`, `source` (`interactive`, `rpc`, `extension`), and `streamingBehavior` (`steer`, `followUp`, or undefined). Firing during a run is implied, not stated. Commands skip this event. |
| 5 | Does a tool result with `terminate: true` end the run? | A tool's `execute` may return `terminate: true`. The run ends early only when every tool result in the same batch is terminating. |
| 6 | Which usage fields does an assistant message carry? | `usage` with a `cost` object is shown. The token field names need checking. |
| 7 | How should the extension start the next step after one passes: send a user message from `agent_settled`, or return a continuation from `agent_before_settle`? | `agent_before_settle` can return `{ entries, continue }` and can request one continuation. `agent_settled` is a notification after which pi is idle. Both exist. Probe both and choose the simpler one that works. |
| 8 | In an SDK session, is `ctx.hasUI` false, and what do `ctx.ui` dialog calls return? | `hasUI` is false in print and JSON modes and true in the terminal interface and RPC mode. The SDK case is not stated. |
| 9 | Can a session file created by the SDK be opened with `pi --session <path>`? | Not stated. |
| 10 | How is the scripted model built (Section 9.1)? | `pi.registerProvider` accepts a custom streaming function. |
| 11 | Which environment variable or flag points pi at a temporary configuration directory? | Older usage docs name `PI_CODING_AGENT_DIR`. |
| 12 | Is there any built-in limit on turns, tokens, cost, or time? | None was found. Check `pi --help` and the settings documentation. |
| 13 | What does a `tool_call` handler return to block a call, and what does the event's input look like for built-in `edit` and `write`? | Return `{ block: true, reason }`. The path field name needs checking. |
| 14 | How does a command handler start an agent run? | `pi.sendUserMessage(content, options)`. While the agent is streaming, `deliverAs` is required. |
| 15 | How does an abort appear to an extension? | `agent_settled` carries `aborted`. |

**Done when.** `docs/pi-facts.md` answers all fifteen questions, and any answer that changes this plan is listed at the top of that file with the proposed change.

### Step 1. Repository skeleton and test rig

**Build.** The repository layout of Section 4. `package.json` with the pinned pi version, `tsconfig.json` in strict mode, `vitest` configuration with the four test directories. An extension entry point that registers nothing except one trivial tool named `harness_ping`. All helpers of Section 9.1.

**Tests.**

- L1: `FakePi` records a registered tool, and the tool's `execute` can be called.
- L1: the fake script returns its entries in order, repeats the last one, and honors `hang`, `garbage`, `exit`, and `big`.
- L1: `makeToyProject` produces a git repository with one commit and a valid configuration.
- L2: a scripted session whose script calls `harness_ping` and then answers with text ends with the expected final text, and the scripted model's request file shows the tool in the tool list.
- L2: a script that runs out makes the helper fail the test.
- L3: `runPiCli` with a script that calls `harness_ping` returns JSON events that include the tool call, and exits with code 0.
- L3: with `--no-extensions` and no `-e`, the tool is absent.

**Done when.** `npm test` passes with no network access, and Andrew can read one test at each level and see how it is written. About 400 lines, most of it rig.

### Step 2. Script runner

**Build.** `core/script.ts`: `runScript(command, input, options)` implementing Section 6. `core/config.ts`: load and validate `harness.json`, with clear messages for each kind of mistake.

**Tests (all L1).**

- A script that prints free text and then a JSON last line yields the parsed result.
- A nonzero exit code yields a script error, not `ok: false`.
- A last line that is not JSON yields a script error.
- A `hang` script with a 300 ms limit is killed and yields `ok: false`, signature `timeout`.
- An abort signal kills a running script.
- A `big` summary is cut to `max_summary_chars`, and the returned text names the number of characters removed and the output path.
- Full output is saved to `log/outputs/`.
- The script receives the JSON object on standard input and the four environment variables.
- Configuration: a missing kind check, an unknown field, a duplicate procedure name, and a `requires` entry that names no procedure each produce a specific message.

**Done when.** The tests pass. About 200 lines.

### Step 3. Event log

**Build.** `core/log.ts`: append-only JSON-lines writer with the common fields, safe against its own failures. Adapter handlers for `session_start`, `session_shutdown`, `tool_execution_start`, `tool_execution_end`, and `message_end`.

**Tests.**

- L1: records have the common fields; `step` is null when no step is active; a write failure does not throw and is reported once.
- L1 (stub): firing `tool_execution_start` and then `tool_execution_end` yields one `tool_call` record with the arguments summary cut to 200 characters.
- L2: a scripted session with two tool calls and three model responses yields two `tool_call` records and three `model_call` records with the scripted usage numbers. Tagged `drift`.
- L3: after a command-line run, `harness/log/events.jsonl` exists in the project and holds a `session_start` record.

**Done when.** Andrew can run pi with the extension on any directory, do something, and read a clear log. About 150 lines.

### Step 4. Plan store, step commands, step prompt

**Build.** `core/plan.ts`: read, write, validate, and hash plan files; the `ACTIVE` pointer; status transitions with the rule that at most one step is active. `core/prompt.ts`: the step template and the system-prompt line. Adapter: `/plan-new`, `/plan-use`, `/plan-status`, `/step`, `/add-step`, `/next-step`, `/retry-step`, `/abandon`, `/plan-close`; the `before_agent_start` handler that adds the system-prompt line; state restore on `session_start`.

**Tests.**

- L1: every legal status transition succeeds; every illegal one is refused with a message, for example starting a step while another is active.
- L1: step ids are `s1`, `s2`, and so on, and never reused.
- L1: the command parser handles `/step offload R17 R18 -- Port both regions`, `/step measure Profile the sample`, an unknown kind, and an empty goal.
- L1: a plan file changed on disk between two reads is detected by the hash.
- L1 (stub): `/step` calls `sendUserMessage` with the exact template text.
- L2: after `/step measure -- Profile it`, the scripted model's request file contains the step template as a user message and the active-step line in the system prompt. Tagged `drift`.
- L2: `/abandon too slow` sets the status and writes `step_end` with outcome `abandoned`.
- L2: a new session on the same project with an active step shows the active-step line again.
- L3: `/plan-new e1 Some goal` given as the prompt creates the plan file. If Step 0 found that commands do not run from the command-line prompt, drive this test through RPC mode instead.

**Manual check.** Create a plan, start a step, and read `/plan-status` in the terminal interface.

**Done when.** Andrew can hand out steps with one line each and see them in the plan file. About 350 lines.

### Step 5. Completion tools and protection

**Build.** `core/check.ts`: `runCheck(step)`, used by `submit` now and by the runner later. `core/protect.ts`: glob matching and the two git questions of Section 7.4. Adapter: the `submit` and `report_blocked` tools; the `tool_call` guard; the refusal to start a step when protected files have uncommitted changes; the plan-file hash prompt.

**Tests.**

- L1: `runCheck` returns pass, fail, and script error for the three fake behaviors, and writes a `check` event each time.
- L1: the protected-file check reports a modified tracked file, a new untracked file, and a file changed and then committed; it reports nothing for a changed unprotected file.
- L1: glob patterns match as documented, including `**`.
- L2: script `[submit, text]` with a passing check: status `passed`, a step record with outcome `passed`, and the run ends without a further model call. Tagged `drift`.
- L2: script `[submit, submit, text]` with check entries fail then pass: two `check` events, the first failure summary is visible to the model in the request file, final status `passed`.
- L2: script `[report_blocked, text]`: status `blocked` with the reason recorded.
- L2: script `[edit a protected file, text]`: the edit is blocked, the file is unchanged, and a `guard_block` event exists. Tagged `drift`.
- L2: script `[bash that overwrites a protected file, submit, text]`: `submit` fails with signature `protected_changed` and lists the file.
- L2: `submit` with no active step returns a refusal and changes nothing.
- L2: a broken check script makes `submit` tell the agent to call `report_blocked`, and the attempt count does not rise.

**Done when.** A step can only become `passed` through the check. About 300 lines.

### Step 6. Interruptions, step records, report

**Build.** Adapter handlers for `input` and `agent_settled` per Section 7.6; `/why`. `core/steps.ts`: assemble the step record of Section 5.4 from the events of one attempt. `core/report.ts` and `bin/harness-report`.

**Tests.**

- L1: from a fixed list of events, the step record has the right interruption counts by reason, check attempts, script failures, tokens, cost, agent minutes, and wait minutes.
- L1: from a fixed `steps.jsonl` of about twelve records, the report prints the expected numbers for each kind, including the completion rate and the unaided rate. Compare against a stored expected output.
- L1 (stub): an `input` event with the person as source during an active step writes an interruption; one with the extension as source does not; one with no active step does not.
- L2: a message sent as steering while a scripted run is in progress writes an interruption with `how: steer`. Tagged `drift`.
- L2: an aborted run writes an interruption with `how: abort`.
- L2: `/why missing-info COMMON block layout` labels the latest interruption, and the step record counts it under `missing-info`.

**Manual check.** In the terminal interface, interrupt a running step by typing, then run `/why`, then finish the step, then run `harness-report`.

**Done when.** After a day of real use, the report tells Andrew something he did not already know. About 300 lines.

### Step 7. Procedure tools

**Build.** Registration of one tool per `procedures` entry, with the parameter schema built from the configuration; the `requires` rule; wait-time accounting.

**Tests.**

- L1: a parameter schema is built correctly for string, number, boolean, and enumerated parameters.
- L1: the `requires` tracker allows `run_sample` after a successful `build`, refuses it after a later `edit`, and allows it again after another successful `build`.
- L2: script `[build, run_sample, text]`: two `script` events, and both tools' summaries reach the model.
- L2: script `[run_sample, text]` with no build: the refusal names `build`.
- L2: a failing procedure is returned as a tool error.
- L2: a procedure marked `is_wait` adds to `wait_minutes` and not to `agent_minutes`, using the fake clock.
- L3: the tools appear when the extension is loaded from a path, with names from the toy configuration.

**Done when.** Adding a new project script as a tool requires only a configuration entry. About 200 lines.

### Step 8. Proposals

**Build.** The `propose_step` tool; `/proposals`, `/accept-step`, `/reject-step`.

**Tests.**

- L1: a proposal is stored with state `open`; accepting it creates a pending step whose origin names the proposal; rejecting it records the reason; neither can be done twice.
- L1: the eleventh open proposal is refused.
- L2: script `[propose_step, text]`: the plan file has one open proposal and no new step.
- L2: `/accept-step p1 start` creates and starts the step, and the model receives the step template.
- L2: `propose_step` with an unknown kind returns a refusal that lists the known kinds.

**Done when.** The agent can suggest the next step, and nothing happens until Andrew accepts. About 150 lines.

### Step 9. Budgets and stop rules

**Build.** `core/budget.ts`: the tracker and its rebuild from the event log. `core/rules.ts`: the decisions of Section 7.7 as one pure function from tracker state and check history to a list of tripped rules. Adapter: evaluation after each model call and after each failed check; the `warn` and `stop` actions.

**Tests.**

- L1: each rule trips at its limit and not one unit before it.
- L1: the stall rule trips on two equal signatures, does not trip on two different ones, does not trip on two empty ones, and trips on an unchanged working tree.
- L1: the tracker rebuilt from an event log equals the tracker that produced the log.
- L1: a step-level budget overrides single fields of the kind's budget.
- L2, action `warn`: a scripted run that exceeds a small token budget continues, and a `rule_tripped` event with action `warn` exists.
- L2, action `stop`: the same run ends early, the step is `stopped` with rule `budget_tokens`, and the remaining script entries are not consumed.
- L2, action `stop`: check entries fail, fail with the same signature: the step is `stopped` with rule `stall`.

**Done when.** A step cannot run without limit in any mode set to `stop`. About 250 lines.

### Step 10. `/run-plan`

**Build.** The mode of Section 7.8, using the mechanism chosen in Step 0; the boundary summary; `/stop-plan`.

**Tests.**

- L1 (stub): the boundary decision function returns continue, stop, or end-of-plan for each combination of step outcome, pending steps, and approval answer.
- L2: two pending steps and a script that passes both, with `approve: auto`: both end `passed`, in order, and the mode in the log is `run_plan`. Tagged `drift`.
- L2: the first step ends `blocked`: the second stays `pending` and the mode ends.
- L2: the agent stops without `submit`: no continuation happens. This is the endless-loop guard.
- L2: `/run-plan 1` with two pending steps runs one.
- L2 or RPC: with `approve: ask`, answering **stop** leaves the second step `pending`.

**Manual check.** Run two steps with `approve: ask` in the terminal interface and read the boundary summary.

**Done when.** Andrew can queue a few steps and approve each boundary with one key. About 200 lines.

### Step 11. Headless runner and control file

**Build.** `runner/run.ts` implementing Section 7.9; `bin/harness-run`; `bin/harness-ctl`; the live feed; the non-interactive branches for every dialog.

**Tests.**

- L1: the outer-loop function, given a fake session object and scripted check results, produces the expected sequence of prompts and the expected stop rule for: pass on first settle; pass after one feedback prompt; `max_iterations`; stall; blocked.
- L2: a plan with two steps and a script that passes both exits with code 0, and both step records have mode `headless`.
- L2: the agent stops without `submit` and the check passes when the runner runs it: the step is `passed` and the `check` event has `by: runner`.
- L2: the agent stops without `submit` and the check fails: the feedback prompt, with the exact template text, appears in the model's request file.
- L2: `fresh_per_step` creates two session files; `continue` creates one.
- L2: a `stop` line in the control file ends the run with rule `aborted_by_user`; a `steer` line reaches the model and is logged as an interruption with `how: control`.
- L2: a plan file changed on disk during the run ends it with rule `plan_changed_externally`.
- L3: `harness-run` as a subprocess on the toy project exits with 0 on success and 2 on a stopped step.
- L3: a session file written by the runner opens with the `pi` executable, if Step 0 found that this works.

**Done when.** A plan runs from start to finish with nobody at the keyboard, and the result can be opened and continued by hand. About 300 lines.

### Step 12. Lessons

**Build.** `core/lessons.ts`: load, match, bound, draft. Adapter: the `tool_result` handler and the drafting pass at step end.

**Tests.**

- L1: header parsing accepts a valid lesson and rejects one with a missing `id`, a missing `pattern`, or an invalid regular expression, each with a specific message.
- L1: matching respects the `tools` list, `max_per_result`, and `max_chars`.
- L1: drafting from a fixed event list writes one draft for a failure followed by a success of the same procedure, and none for a failure with no later success.
- L2: a failing `build` whose output matches a lesson returns a result that ends with `[lesson <id>]` and the lesson text, visible in the model's request file, and a `lesson_injected` event exists. Tagged `drift`.
- L2: a lesson file added during a session is not used until the next session.
- L2: a procedure with `lesson_trigger: false` never receives a lesson.

**Done when.** A known compiler error brings its stored workaround to the agent at the moment the error appears. About 200 lines.

### Step 13. Live tests, documentation, installation

**Build.**

- Level 4 tests, run only when `HARNESS_LIVE_MODEL` is set: (a) a toy step whose check passes when a file contains a given word; the model should edit the file and call `submit`; (b) a toy step that cannot be done; the model should call `report_blocked`; (c) a toy step after which the model is asked to suggest a next step; it should call `propose_step`.
- `README.md`: installation, a five-minute walkthrough on the toy project, the configuration reference, the script contract, and the list of logs.
- A five-line snippet for a project's `AGENTS.md` context file that states the completion rule and names the `harness/` directory.
- A template `harness/` directory with example configuration and stub scripts that print a valid result.

**Done when.** Andrew can set up a new project from the template in under fifteen minutes, and the three live tests pass in at least two of three runs with the model he uses.

---

## 11. Risks

| Risk | Response |
|---|---|
| pi's API changes between versions. | Exact version pin; `drift` tests; types-only stub; `docs/pi-facts.md`. |
| A stop that depends on `terminate` does not end the run when the model calls other tools in the same batch. | Treat `terminate` as a convenience. Correctness rests on the step's status, which the boundary logic and the runner read. |
| The agent changes tests through the shell. | Detected at `submit` by the git comparison. Not prevented. Stated in the README. |
| An unconditional continuation loops. | A continuation happens only directly after a step has passed. One L2 test covers the case where the agent stops without `submit`. |
| An aborted run leaves queued jobs. | The contract makes the script responsible for cancelling on the terminate signal. The real scripts must be tested for this when they are written. |
| An unattended run spends an allocation or a budget. | Per-step budgets with action `stop`; the run ends at the first step that does not pass. |
| The ceremony does not match the real work. | Rolling plan; one-line `/step`; `abandoned` as a normal ending; optional `/why`; open set of kinds. Review after two weeks of real use and remove what went unused. |
| Lessons go stale after a compiler upgrade. | Each lesson records compiler version, machine, and date. A person retires lessons. Lessons are frozen per session. |
| The stub of pi's API drifts from the real one. | The stub is checked by the compiler against pi's types, and every wiring path also has a level 2 test. |

---

## 12. Decisions made in this plan that Andrew may want to change

These were chosen as defaults. Each is cheap to change before the step that implements it.

1. The plan file is JSON, not YAML or Markdown (Step 4).
2. The extension lives in its own repository (Step 1).
3. The test framework is `vitest` (Step 1).
4. Stop rules warn in supervised mode and stop in the other two modes (Step 9).
5. The headless runner uses a fresh session for each step (Step 11).
6. The headless runner ends the whole run at the first step that does not pass (Step 11).
7. Lesson drafts leave cause and workaround empty, and the extension makes no model calls of its own (Step 12).
8. The three starting kinds are `restructure`, `offload`, and `measure` (configuration only).
9. Tool and command names as listed in Section 7.
10. There is no plan-level completion rate (Section 7.11).

---

## 13. Sources for statements about pi

Statements in this plan about pi's API were read from these pages on 9 November 2026. Only parts of the long extensions page were read. Everything else in this plan is design, not a sourced fact.

- Extensions: https://pi.dev/docs/latest/extensions
- SDK: https://pi.dev/docs/latest/sdk
- Command line: https://pi.dev/docs/latest/cli
- Custom providers: https://pi.dev/docs/latest/custom-provider
- Third-party test harnesses mentioned as a fallback: https://github.com/marcfargas/pi-test-harness and the npm package `pi-mock`
