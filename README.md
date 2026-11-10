# epochryphal

A pi extension for supervised and unattended code-porting work. The agent finishes a step only when a check script passes. Every tool call, model call, typed message, and check result goes into a log, and a report computes completion rates and interruption counts from that log. The same code runs one supervised step, a sequence of steps with approval between them (`/run-plan`), and an unattended run (`harness-run`).


Contents: [Installation](#installation) · [Walkthrough](#walkthrough) · [Files in the project](#files-in-the-project) · [Configuration](#configuration-harnessharnessjson) · [Script contract](#script-contract) · [Commands](#commands-for-the-person) · [Agent tools](#tools-for-the-agent) · [Stop rules](#budgets-and-stop-rules) · [Headless runs](#headless-runs) · [Lessons](#lessons) · [Logs](#logs) · [Report](#report) · [AGENTS.md snippet](#agentsmd-snippet) · [Tests](#tests) · [Limits](#limits)

## Installation

Requirements: Node 22.18 or later (the bins are TypeScript files that Node runs by stripping types), git, and pi 1.5.1. The project you work on must be a git repository with at least one commit.

The package is installed from a checkout of this repository. It is not published to npm, and installing it from an npm tarball does not work for the bins (see [Limits](#limits)).

Steps 1 and 2 are required. Step 3 is optional: it only puts the command-line programs on your `PATH`. Steps 2 and 3 are independent; one registers the checkout with pi, the other with npm.

1. Get a checkout of this repository, then install its development dependencies, which include the pinned pi SDK that `harness-run` uses:

   ```sh
   cd /path/to/epochryphal
   npm install
   ```

2. Make pi load the extension, which provides the commands such as `/step` and `/run-plan`. The source must be the path of the checkout; a bare package name does not work because the package is not on npm. Either install the checkout as a pi package, which writes it to `~/.pi/agent/settings.json` and loads it in every pi session:

   ```sh
   pi install /path/to/epochryphal
   pi list
   ```

   or load it for one invocation only:

   ```sh
   pi -e /path/to/epochryphal
   ```

   pi reads the extension's entry point from the `pi.extensions` field of `package.json` (`./src/extension/index.ts`) and loads it with its own TypeScript loader. pi loads a local package from its path without copying it, so edits in the checkout take effect at the next session. pi's documentation also describes `pi install -l` (project settings in `.pi/settings.json`), which loads only after project trust is granted; that variant was not verified here.

3. Optional: put the three command-line programs (`harness-run`, `harness-ctl`, `harness-report`) on your `PATH` by installing the checkout globally with npm. For a local directory npm creates symbolic links to the checkout, so Node runs the files in the checkout:

   ```sh
   npm install -g /path/to/epochryphal
   harness-report --project /path/to/project
   ```

   This was verified with `npm install -g --prefix <temporary directory> <checkout>` (test/cli/install.test.ts does the same). Without step 3 you can run the bins directly, for example `node /path/to/epochryphal/src/bin/harness-report.ts --project .`.

The extension is active in a pi session only when `harness/harness.json` exists in pi's working directory or a directory above it. Otherwise it writes one warning and does nothing.

### Uninstalling

Undo each installation separately. `pi remove` takes the same source that `pi install` was given (`pi list` shows it); `pi uninstall` is an alias. The npm command is needed only if you did step 3.

```sh
pi remove /path/to/epochryphal
npm uninstall -g epochryphal
```

These two commands are taken from `pi --help` and npm's documentation; they were not run here. Neither touches the checkout or any project's `harness/` directory.


## Walkthrough

This takes about five minutes on a copy of the template. It uses a real model; the stub scripts do no work, and every check passes. The test `test/sdk/template.test.ts` runs the same commands with a scripted model, and the outputs quoted below are from that test.

### Set up a project

```sh
mkdir demo && cd demo
git init
cp -r /path/to/epochryphal/template/harness .
cat /path/to/epochryphal/template/AGENTS.md >> AGENTS.md
git add -A
git commit -m "Add the harness"
```

`template/harness/` holds `harness.json`, the stub scripts `scripts/check`, `scripts/build`, and `scripts/run_sample`, one example lesson, and a `.gitignore` that keeps `harness/log/` out of git. Commit the harness before you start a step: a step does not start while files that match a `protected` pattern have uncommitted changes, and `harness/scripts/**` is protected.

### One supervised step

Start pi in the project (`pi`, with the extension installed as above) and type:

```
/plan-new demo Try the harness on this project
```

pi shows `Plan demo created and active.` The file `harness/plans/demo.json` now exists, and `harness/plans/ACTIVE` names it.

```
/step measure -- Build the cpu variant, run the sample, then submit.
```

This adds step `s1` of kind `measure` and starts it. The agent receives this message:

```
[harness step s1 | kind: measure | plan: demo]
Epoch goal: Try the harness on this project
Step goal: Build the cpu variant, run the sample, then submit.
You are finished only when the `submit` tool passes. If you cannot proceed, call
`report_blocked` with the reason. Do not change files under: harness/harness.json, harness/scripts/**, harness/lessons/**, tests/**.
```

You should see the agent call `build` (with `variant` `cpu`), then `run_sample`, then `submit`. Each procedure returns its stub summary, for example `Stub build: nothing was built. Replace harness/scripts/build with the real build.` The `submit` result is:

```
The check passed: Stub check for kind measure: it passes every step. Replace harness/scripts/check with a real check.
Step s1 passed. Stop here.
```

A model may choose a different order; `run_sample` refuses to run until `build` has succeeded in the step (its `requires`).

```
/plan-status
```

shows:

```
Plan demo: Try the harness on this project
  s1 passed    measure: Build the cpu variant, run the sample, then submit.
```

While a step is active, `/plan-status` also shows the step's usage against its budget. Leave pi and run the report:

```sh
harness-report --project .
```

Its first table has one row for `measure`, with 1 attempt, 1 passed, a completion rate of 100%, and the tokens and cost the model used. `harness/log/events.jsonl` holds every event of the session and `harness/log/steps.jsonl` one record for `s1`.

### Several steps with /run-plan

In pi:

```
/add-step measure -- Profile the sample workload.
/add-step restructure -- Split the solver routine in two.
/run-plan
```

`/add-step` answers `Added s2 (measure): Profile the sample workload.` and `Added s3 (restructure): ...`. `/run-plan` starts `s2`. When `s2` passes, a dialog shows the boundary summary and asks whether to start `s3`, with the choices **Continue**, **Stop**, and **Stop and edit the plan**:

```
Step s2 passed: Profile the sample workload.
Check: Stub check for kind measure: it passes every step. Replace harness/scripts/check with a real check.
Used: <tokens> tokens, $<cost>
Next: s3: Split the solver routine in two.

Start s3?
```

After **Continue** and a pass of `s3`, pi shows `run-plan ended: the plan has no pending step left. The session is supervised again.`

### An unattended run with harness-run

Add a pending step in pi (`/add-step measure -- Profile the sample workload again.`), leave pi, and run:

```sh
harness-run --project . --plan demo --model <provider>/<model id>
```

`<provider>/<model id>` is a model pi knows and has credentials for, as shown by `pi --list-models`. The runner prints the path of the session file, then one line per logged event: the time, the step, the event type, a short description, and the run's token and cost total. It exits 0 when every attempted step passed, 2 when a step ended any other way, and 1 on a program error.

While it runs, from another terminal in the project:

```sh
harness-ctl steer "Use the cpu build only."
harness-ctl stop
```

`steer` passes the text to the agent and logs it as an interruption with `how: control`. `stop` aborts the run and marks the active step `stopped` with the rule `aborted_by_user`. The runner reads the control file every 250 ms. Open the saved session afterwards with `pi --session <absolute path of the session file>` to continue by hand.

## Files in the project

All paths are relative to the project root. The directory is always named `harness/`.

| Path | Written by | Contents |
|---|---|---|
| `harness/harness.json` | person | Configuration |
| `harness/scripts/` | person | Check and procedure scripts |
| `harness/plans/<plan_id>.json` | harness (and person, with confirmation) | One plan per epoch |
| `harness/plans/ACTIVE` | harness | One line: the active plan id |
| `harness/lessons/*.md` | person | Approved lessons |
| `harness/lessons/drafts/*.md` | harness | Lesson drafts for a person to fill in |
| `harness/log/events.jsonl` | harness | Every event, append-only |
| `harness/log/steps.jsonl` | harness | One record per finished step attempt |
| `harness/log/outputs/` | harness | Full output of each script call |
| `harness/log/control.jsonl` | `harness-ctl` | Commands for a running `harness-run` |

Put `harness/log/` in `.gitignore` (the template's `harness/.gitignore` does this).

A plan file has `plan_id`, `goal`, `created_at`, `steps`, `proposals`, and `exit`. A step has `id` (`s1`, `s2`, ...), `kind`, `goal`, `check_args`, `origin` (`user` or `proposal:<id>`), `status` (`pending`, `active`, `passed`, `blocked`, `abandoned`, `stopped`), `attempt`, an optional `budget` that overrides single fields of its kind's budget, and `reason` for a step that ended blocked, abandoned, or stopped. A proposal has `id` (`p1`, ...), `kind`, `goal`, `check_args`, `rationale`, `proposed_in_step`, `state` (`open`, `accepted`, `rejected`), and an optional `reason`. `exit` is null until `/plan-close`, then `{ "decision", "note", "at" }`. At most one step is active.

## Configuration: harness/harness.json

`template/harness/harness.json` is a complete example. The loader reports every problem at once, each naming the field by its path. A field that is not listed here is an error. Procedure tools and lessons are read when a pi session starts; the other fields are read each time they are used.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | required | Format version. |
| `max_summary_chars` | positive whole number | `2000` | Longest script summary returned to the agent. |
| `protected` | list of glob patterns | `[]` | Files the agent must not change. `*` and `?` match within one path part, `**` across parts; a pattern matches the whole path relative to the project root. |
| `kinds` | object | required, at least one | Kinds of step, by name. A name uses lowercase letters, digits, `-` and `_`, starting with a letter. |
| `kinds.<k>.description` | string | required | |
| `kinds.<k>.check` | non-empty list of strings | required | The check command. The step's `check_args` are appended. |
| `kinds.<k>.check_timeout_s` | positive number | required | Time limit of one check, in seconds. |
| `kinds.<k>.budget.tokens` | positive number | required | Tokens per step attempt. |
| `kinds.<k>.budget.cost_usd` | positive number | required | Cost per step attempt, in dollars, as pi reports it. |
| `kinds.<k>.budget.agent_minutes` | positive number | required | Wall-clock minutes per step attempt, minus time in `is_wait` procedures. |
| `kinds.<k>.budget.check_attempts` | positive whole number | required | Failed checks that stop the step. |
| `procedures` | list | `[]` | Project scripts exposed to the agent as tools. |
| `procedures[i].name` | string | required | Tool name: lowercase letters, digits, `_`, starting with a letter. Unique. Not `submit`, `report_blocked`, `propose_step`, or `harness_ping`. A name that pi already has as a tool (such as `read`) is skipped at session start with a warning. |
| `procedures[i].description` | string | required | Tool description shown to the model. |
| `procedures[i].command` | non-empty list of strings | required | The command. |
| `procedures[i].params` | object | `{}` | Parameters by name: `{ "type": "string" \| "number" \| "integer" \| "boolean", "description"?, "enum"? }`. `enum` is allowed only for strings. Every parameter is required in the tool's schema. |
| `procedures[i].timeout_s` | positive number | required | Time limit in seconds. |
| `procedures[i].is_wait` | boolean | `false` | Time inside this procedure counts as wait time, not agent minutes. |
| `procedures[i].requires` | list of procedure names | `[]` | Procedures that must have succeeded earlier in the same step, with no `edit` or `write` by the agent since. Cycles are errors. |
| `procedures[i].lesson_trigger` | boolean | `false` | Failed results of this procedure are matched against lessons. |
| `rules.supervised` | `"warn"` or `"stop"` | `"warn"` | What a tripped stop rule does in a supervised session. |
| `rules.run_plan` | `"warn"` or `"stop"` | `"stop"` | The same, in `/run-plan` mode. |
| `rules.headless` | `"warn"` or `"stop"` | `"stop"` | The same, in `harness-run`. |
| `rules.max_iterations` | positive whole number | `3` | Prompts `harness-run` sends for one step (the step prompt plus feedback prompts) before it stops the step. |
| `run_plan.approve` | `"ask"` or `"auto"` | `"ask"` | Whether `/run-plan` asks before each next step. |
| `headless.session_mode` | `"fresh_per_step"` or `"continue"` | `"fresh_per_step"` | Default for `harness-run --session-mode`. |
| `lessons.max_per_result` | positive whole number | `2` | Lessons appended to one failed result. |
| `lessons.max_chars` | positive whole number | `1500` | Longest total text of the lessons appended to one result. |

A command whose program contains `/` is resolved against the project root, and the loader checks that it exists and is executable. A program without `/` is looked up on the `PATH` when it runs.

## Script contract

Checks and procedures are run the same way (`src/core/script.ts`).

**Call.**

- The command runs as a process without a shell, in its own process group, with the project root as working directory. For a check, the step's `check_args` are appended to the command.
- Standard input receives one JSON object: `{ "params": { ... }, "plan": "...", "step": "...", "attempt": 1, "kind": "..." }`. For a check, `params` is `{}`. For a procedure called with no active step, `plan`, `step`, `attempt`, and `kind` are null.
- The same values are in the environment as `HARNESS_PLAN`, `HARNESS_STEP`, `HARNESS_ATTEMPT`, and `HARNESS_KIND` (empty strings when null).

**Result.**

- The last non-empty line of standard output must be one JSON object. Earlier lines and standard error are free-form.

  ```json
  { "ok": true,
    "summary": "Short text for the agent.",
    "signature": "optional short string that identifies this kind of failure",
    "details_path": "optional path to a longer report",
    "data": { "optional": "structured values" } }
  ```

- `ok` (boolean) and `summary` (string) are required. `signature` and `details_path` must be strings or null; an empty signature counts as none. `data` and `details_path` are accepted but not written to the log in this version.
- Exit code 0 means the script ran, and `ok` says whether the result is a success. A nonzero exit code, death by a signal, a program that cannot start, or a last line that is not such an object is a **script error**: the script itself is broken. A script error on a check never counts as a failed attempt by the agent.

**Bounds.**

- All standard output and standard error go to `harness/log/outputs/<time>-<name>.txt` as they arrive, after a first line with the command and before a last line with the outcome.
- The agent receives the `summary`, cut to `max_summary_chars`. Cut text ends with a line `[N characters removed; full output: <path>]`.

**Time limits and aborts.**

- When the time limit passes, or the run is aborted (Escape in pi, `/abandon`, a stop rule, `harness-ctl stop`), the harness sends SIGTERM to the script's process group and SIGKILL five seconds later.
- A call that hits its time limit returns `ok: false`, the summary `timed out after N minutes` (or seconds), and the signature `timeout`. An aborted call is neither a success nor a failure.
- A script that submits queued jobs must cancel them when it receives SIGTERM. The harness does not know about schedulers.
- If the process running the harness exits or receives SIGINT, SIGTERM, or SIGHUP, running scripts receive SIGTERM.

**How results are used.** A procedure result with `ok: false` is returned to the agent as a tool error, possibly with lessons appended. A script error is returned as a tool error that says the script is broken. For a check, `ok: true` passes the step; `ok: false` is a failed attempt; a script error tells the agent to call `report_blocked` (in `harness-run` it stops the step with the rule `check_error`).

## Commands for the person

| Command | Effect |
|---|---|
| `/plan-new <plan_id> <goal>` | Create a plan and make it active. Refused while a step is active. |
| `/plan-use <plan_id>` | Make an existing plan active. Refused while a step is active. |
| `/plan-status` | Show the goal, each step with its status, open proposals, and the active step's usage against its budget. |
| `/plan-close <keep\|revert\|continue> <note>` | Record the closing decision in `exit`. Refused while a step is active. |
| `/step <kind> [check args...] -- <goal>` | Add a step and start it. Without `--`, all text after the kind is the goal and there are no check arguments. |
| `/add-step <kind> [check args...] -- <goal>` | Add a pending step without starting it. |
| `/next-step` | Start the first pending step. |
| `/retry-step [step_id]` | Start a blocked, abandoned, or stopped step again with its attempt number raised by one. Default: the latest such step. |
| `/abandon <reason>` | End the active step as abandoned. Aborts the agent's run if it is working. |
| `/proposals` | List open proposals with their rationale. |
| `/accept-step <proposal_id> [start]` | Turn a proposal into a pending step; with `start`, also start it. |
| `/reject-step <proposal_id> [reason]` | Mark a proposal rejected. |
| `/why <reason> [note]` | Label the latest interruption of the active step. `reason` is one of `wrong-direction`, `missing-info`, `environment`, `too-slow`, `other`. |
| `/run-plan [n]` | Run up to `n` pending steps one after another (default: all), pausing at each boundary. |
| `/stop-plan` | End `/run-plan` after the current step. |

A command that starts a step is refused while another step is active, while the agent is working, or while protected files have uncommitted changes (it lists them).

Starting a step sets it active, records the current git commit, logs `step_start`, and sends the step prompt shown in the walkthrough. While a step is active, every agent run also gets this line in its system prompt: `Active harness step <id>: <goal> Finish with submit or report_blocked.`

An **interruption** is recorded while a step is active when the person sends a message while the agent works (`how` is `steer` or `follow_up`), sends a message while the agent is idle (`idle_message`), or aborts the run (`abort`); and when `harness-ctl steer` reaches a headless run (`control`). Slash commands, the harness's own messages, and aborts the harness makes itself are not interruptions.

`/run-plan` starts the first pending step. After each agent run settles it continues only if the step it started passed in that run and the run was not aborted; any other ending ends the mode with a notice saying why. With `approve: ask` it asks at each boundary (Escape counts as **Stop**); with no user interface it ends the mode instead of asking. **Stop and edit the plan** ends the mode and shows the plan. The mode is not restored after pi restarts.

## Tools for the agent

| Tool | Parameters | Effect |
|---|---|---|
| `submit` | `note?` | Runs the protected-file check, then the kind's check. On a pass the step becomes `passed` and the run ends. On a failure the agent sees the summary and the stop rules for check attempts and stalls apply. Refused when no step is active. |
| `report_blocked` | `reason` | Marks the step `blocked` with the reason and ends the run. |
| `propose_step` | `kind`, `goal`, `check_args?`, `rationale` | Adds an open proposal to the plan. It never creates a step. Refuses an unknown kind (and lists the known ones) and an eleventh open proposal. |
| `harness_ping` | none | Returns `pong`. For checking that the extension is loaded. |
| one per `procedures` entry | from `params` | Checks `requires`, runs the script, logs a `script` event, and returns the bounded summary. Works with or without an active step. |

**Protection.** A handler on pi's `tool_call` event blocks pi's built-in `edit` and `write` tools when the target matches a `protected` pattern or lies under `harness/plans/` or `harness/log/`; the agent gets the reason and a `guard_block` event is written. Lesson drafts under `harness/lessons/drafts/` may be edited. At each check, git is asked which protected files differ from the commit recorded at step start and which are modified or untracked. Any such file fails the check with the signature `protected_changed` (a counted attempt), and the check script does not run.

## Budgets and stop rules

A tracker for the active step attempt adds up tokens and cost from each model call (including compaction and branch summaries), agent minutes (wall-clock time since the step started, minus time inside `is_wait` procedures), and check attempts (checks that produced a result). The budget is the kind's `budget` with the step's own `budget` fields on top.

| Rule | Trips when | Modes |
|---|---|---|
| `budget_tokens`, `budget_cost`, `budget_minutes` | Usage is over the budget. Checked after every model call and after every failed check. | all |
| `max_check_attempts` | Failed checks reach `check_attempts`. | all |
| `stall` | The last two failed checks have the same non-empty signature, or the working tree is unchanged between them. | all |
| `check_error` | The check script is broken, or the check cannot run. | `harness-run` only |
| `max_iterations` | `rules.max_iterations` prompts were sent without a pass. | `harness-run` only |
| `plan_changed_externally` | The plan file was changed or deleted by someone else during the run. | `harness-run` only |
| `aborted_by_user` | `harness-ctl stop`. | `harness-run` only |

Each rule acts at most once per step attempt. The first four rows act by the setting for the session's mode (`rules.supervised`, `rules.run_plan`, `rules.headless`):

- `warn`: a `rule_tripped` event with `action: warn` is written and the person sees a notice. Work continues. In a session without a user interface the notice goes to standard error.
- `stop`: a `rule_tripped` event with `action: stop` is written, the step becomes `stopped`, its step record names the rule, every further tool call in the run is refused with a reason, and the run is aborted at the end of the turn. In `/run-plan` the mode then ends; in `harness-run` the whole run ends with exit code 2.

The four headless-only rules always stop. A budget is checked after a model call, so the last call can exceed it; the actual usage is recorded.

## Headless runs

```
harness-run --project <dir> --plan <plan_id> --model <provider>/<model id>
            [--steps <n>] [--session-mode fresh_per_step|continue]
            [--session-dir <dir>] [--extension <path>]...
```

- For each pending step in order, up to `--steps`: start it (as `/next-step` does), send the step prompt, and wait for the run to settle. If the step is still active, run the check itself (the `check` event has `by: runner`); on a pass the step is `passed`; on a failure apply the stop rules and send the feedback prompt (`The check for step <id> did not pass:`, the summary, and `Continue working. Call submit when the step is complete, or report_blocked if you cannot proceed.`). After `rules.max_iterations` prompts the step is stopped with `max_iterations`. The run ends at the first step that does not pass.
- `--session-mode fresh_per_step` opens a new pi session for each step; `continue` keeps one. The default comes from `headless.session_mode`.
- Sessions are saved to files, in pi's session directory for the project unless `--session-dir` is given. The runner prints each session file's path.
- `--extension` loads a pi extension by path, as `pi -e` does. The runner loads no other extensions: none from the person's or the project's settings, none from installed packages, and none of pi's built-in extensions. pi's settings and its other resources, such as context files and skills, load as usual.
- The runner refuses pi's cache-warming requests, so all model usage goes through the step budget.
- The runner refuses to start when the plan is closed, has an active step, or another active plan has an active step. It makes the plan the active one.
- It never asks a question. Exit codes: 0 when every attempted step passed (or there was nothing to run), 2 when a step ended any other way or `harness-ctl stop` was given, 1 on a program error or bad arguments.

`harness-ctl [--project <dir>] steer "<text>" | stop` appends a line to `harness/log/control.jsonl`. Without `--project` it uses the nearest directory at or above the current one that holds `harness/harness.json`. A running `harness-run` reads only lines added after it started.

## Lessons

A lesson is a Markdown file in `harness/lessons/` (`template/harness/lessons/` has an example):

```markdown
---
id: example-build-missing-module
pattern: "Cannot open module file '[a-z_]+\\.mod'"
tools: [build]
compiler: example
machine: any
date: 2026-11-10
evidence: "an example lesson that ships with the template; delete it"
---
Cause: a module was compiled after a file that uses it, so its .mod file did not exist yet.
Workaround: build the module's source file first, or fix the order of sources in the build file.
```

- The header is a small fixed format, not YAML: `key: value` lines between two `---` lines. A value is plain text, a JSON string in double quotes, or a list `[a, b]` of bare words or JSON strings. `id` (letters, digits, `.`, `_`, `-`), `pattern` (a non-empty JavaScript regular expression, used without flags), `tools` (a non-empty list of procedure names), and text after the header are required. Other fields are free. A lesson longer than `lessons.max_chars` is refused.
- Lessons are loaded once when a session starts. A file that cannot be used is skipped with a warning that says why. A lesson added during a session is used from the next session.
- When a procedure with `lesson_trigger: true` returns `ok: false`, each lesson whose `tools` contains the procedure and whose `pattern` matches the text the agent sees is appended to the result as `[lesson <id>]` followed by its text, at most `max_per_result` lessons and `max_chars` characters. A `lesson_injected` event is written for each.
- When a step passes, the harness writes a draft to `harness/lessons/drafts/` for each procedure failure in that attempt that a later success of the same procedure followed. The draft has an empty `pattern`, the first 40 lines of the failing output, the step, and the commit range. A draft has no effect until a person fills it in and moves it to `harness/lessons/`.
- The extension never calls a model itself.

## Logs

### harness/log/events.jsonl

One JSON object per line. Every record has `ts`, `session` (pi's session id), `mode` (`supervised`, `run_plan`, or `headless`), `plan`, `step`, `attempt` (all three null when no step is active), and `type`. Extra fields by type:

| `type` | Extra fields |
|---|---|
| `session_start`, `session_end` | `reason` |
| `step_start` | `kind`, `goal`, `origin`, `commit` (the git commit at start) |
| `step_end` | `outcome` (`passed`, `blocked`, `abandoned`, `stopped`), `detail` (the reason or the submit note) |
| `model_call` | `model`, `input`, `output`, `cache_read`, `cache_write`, `total_tokens`, `cost_usd`, `stop_reason` (`compaction` or `branch_summary` for model calls pi makes outside a run) |
| `tool_call` | `tool`, `args_summary` (first 200 characters), `duration_ms` (null when the call did not run), `is_error`, `parent` (id of the tool call that made this call, or null) |
| `script` | `name`, `is_wait`, `outcome` (`result`, `script_error`, `aborted`), `ok` (null without a result), `signature`, `duration_ms`, `timed_out`, `output_path` |
| `check` | `outcome`, `ok`, `signature`, `summary`, `duration_ms`, `by` (`submit` or `runner`), `tree` (working-tree fingerprint at a failed check, for the stall rule) |
| `interruption` | `how` (`steer`, `follow_up`, `idle_message`, `abort`, `control`), `text_head` (first 200 characters), `reason`, `note`, `label_of` (for a `/why` label, the number of the interruption it labels; else null) |
| `guard_block` | `tool`, `path` |
| `protected_changed` | `paths` |
| `plan_changed_externally` | `plan` |
| `rule_tripped` | `rule`, `action` (`warn` or `stop`), `value`, `limit` (null for rules without a measured quantity) |
| `proposal` | `proposal_id`, `action` (`proposed`, `accepted`, `rejected`) |
| `lesson_injected` | `lesson_id`, `tool` |
| `lesson_drafted` | `path` |

A failure to write the log never stops the agent's work; the first failure is reported to the person.

### harness/log/steps.jsonl

One record per finished step attempt, built from that attempt's events:

`ts`, `plan`, `step`, `attempt`, `kind`, `origin`, `mode`, `outcome`, `stop_rule` (null unless stopped), `reason` (null for passed), `interruptions`, `interruptions_by_reason` (unlabeled interruptions count as `unlabeled`), `check_attempts`, `script_failures`, `tokens`, `cost_usd`, `agent_minutes`, `wait_minutes`, `model_calls`.

### Other files

- `harness/log/outputs/<time>-<name>.txt`: full output of each script call.
- `harness/log/control.jsonl`: `{"ts": "...", "cmd": "steer", "text": "..."}` or `{"ts": "...", "cmd": "stop"}`.

## Report

```sh
harness-report --project <dir> [--plan <plan_id>] [--since <date>] [--format md|csv]
```

It reads `harness/log/steps.jsonl` and the plan files and prints, per kind: attempts; counts of passed, blocked, abandoned, and stopped; completion rate (passed attempts over all attempts); unaided rate (passed attempts with no interruptions over all attempts); and median tokens, cost, agent minutes, and check attempts. It also prints interruptions by reason and kind, stop rules by count, and per plan the number of steps, steps from proposals, proposals accepted and rejected, and the closing decision. `--format csv` prints only the per-kind table. There is no plan-level completion rate.

## AGENTS.md snippet

`template/AGENTS.md` holds these lines for a project's `AGENTS.md`:

```markdown
## Harness
This project uses a harness: its configuration, check and procedure scripts, plans, lessons, and logs are under `harness/`.
A harness step is finished only when the `submit` tool passes; your own judgment that the work is done does not finish it.
If you cannot finish a step, call `report_blocked` with the reason instead of stopping.
Do not change files that match the `protected` patterns in `harness/harness.json`, or anything under `harness/plans/` or `harness/log/`.
```

## Tests

```sh
npm test            # tsc --noEmit, then levels 1 to 3; no network, no cost
npm run test:unit   # level 1
npm run test:sdk    # level 2: pi in-process with a scripted model
npm run test:cli    # level 3: the pi executable and the bins as subprocesses
npm run test:drift  # tests tagged drift: run first after a pi upgrade
npm run test:live   # level 4: skipped unless HARNESS_LIVE_MODEL is set
```

### Live tests

`HARNESS_LIVE_MODEL=<provider>/<model id> npm run test:live` runs `test/live/live.test.ts` against that model, with pi's own credentials (environment variables or pi's configuration directory). Without the variable the three tests show as skipped. The three cases are: (a) a step whose check passes when a file contains a word, where the model should edit the file and call `submit`; (b) a step that asks for a change to a protected file, where the model should call `report_blocked`; (c) a step followed by a request for a next step, where the model should call `propose_step`. Each case runs three times on a fresh project and passes when at least two runs pass; the tally is printed to standard error.

What a live run can cost at most: there are 9 sessions (3 cases, 3 runs each). Each step's budget is 200,000 tokens, $0.50, and 5 agent minutes with `rules.supervised` set to `stop`, and each session is aborted once it has used more than 300,000 tokens or $0.75 in total, after the model call that passed the limit. Each prompt is aborted after 3 minutes. The upper bound is therefore 9 × $0.75 = $6.75 plus nine model calls' overshoot, as measured by pi's cost figures; for a model whose price pi does not know, pi reports zero cost and only the token cap (2.7 million tokens over the run, plus the overshoot) applies.

## Limits

What the harness does not do, or what was not verified:

- **Shell edits to protected files are detected at `submit`, not prevented.** The guard covers only pi's built-in `edit` and `write`. The agent's shell can change any file the person can.
- **`requires` does not see shell edits.** Only calls to the built-in `edit` and `write` reset it; the real scripts remain the final authority on whether a build is stale.
- **`agent_minutes` counts wall-clock time** from step start, minus time in `is_wait` procedures. It includes time the agent sat idle waiting for the person and time pi was closed while the step stayed active.
- **Cache-warming usage is invisible to extensions in interactive sessions.** pi's cache warming re-sends requests without an event the harness can count, so those tokens escape the step budget. `harness-run` refuses cache warming. A tool's own model usage (`tool_result.usage`) is not counted either, and a compaction model set in pi's settings is logged under the session's model name.
- **A plan edited by hand needs confirmation.** In a session with a user interface the harness shows what changed and asks; without one it refuses the change, and in `harness-run` it stops the active step with `plan_changed_externally`.
- **Step ids can be reused** if the last step is deleted from the plan file by hand: the next id is one more than the highest id present. The log would then hold two steps with the same id.
- **The project must be a git repository with at least one commit.** Steps do not start otherwise.
- **`harness-run` loads no other user extensions** unless they are given with `--extension`. It does load the person's pi settings, context files, and skills.
- **Not run: the manual checks in pi's terminal interface and the live tests.** The steps' manual checks (reading `/plan-status`, typing to interrupt a step, the `/run-plan` dialog with a multi-line title) were not done; the dialog and typed input were tested only through the SDK. The level 4 tests have never been run against a model.
- **The bins work only from a checkout.** Node does not strip TypeScript types for files under `node_modules`. Installing from an npm tarball (verified with `npm pack` and `npm install -g <tarball>`) gives `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` when a bin runs. `pi install npm:...` and `pi install git:...` were not tried, because the package is not published and those need the network; pi itself loads an extension under `node_modules` with its own loader, but such a copy does not put the bins on the `PATH`.
- **The `harness/` directory name is fixed.** The plan made it configurable; the code does not.
- **Script `data` and `details_path` are not logged.**
- **Changes to `procedures` or to lessons take effect in the next session.** A tool that another extension registers after session start is not checked against procedure names.
- **A budget is checked after each model call,** so the last call of a step can exceed it.
- **Lesson patterns have no time limit.** A regular expression with catastrophic backtracking could take very long; the text it is tested against is bounded by `max_summary_chars`.
- **A steer sent to `harness-run` after a step's last run** is logged but reaches the model only if the session runs again (in `continue` mode, the next step).
- **`/abandon` followed at once by another `/step`**, within a few promise turns (an RPC client could do this; typing cannot), could let the first step's prompt run under the second step.
- **`/run-plan` is session state** and is not restored after pi restarts.
- **Only Linux was used.** The script runner relies on POSIX process groups and signals.
