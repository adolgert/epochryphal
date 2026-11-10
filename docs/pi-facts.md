# Facts about the installed pi

- pi version: **1.5.1** (`@earendil-works/pi-coding-agent`, global install under nvm, Node 22.20.0).
- Bundled versions: `@earendil-works/pi-ai` 1.5.1, `typebox` 1.3.27; pi's own packages use `vitest` 4.1.12.
- Verified 9 November 2026 by reading `docs/`, `dist/**/*.d.ts`, `dist/**/*.js`, and running the probes in `docs/probes/`.
- "Read" means the docs or types say so. "Probed" means a probe ran and the result was seen.

---

## Changes this plan needs

Each item says what the plan assumed, what is true, and the change I propose.

1. **The scripted model uses pi-ai's faux provider, wrapped (Section 9.1, option 1).** `createFauxCore` is exported from `@earendil-works/pi-ai`. It overwrites each response's `usage` with an estimate based on characters (`withUsageEstimate`), so token counts are not fixed. **Proposal:** the scripted model is a small extension (`test/rig/scripted-model.ts`). It builds a faux core, wraps the core's stream so every message carries fixed usage (100 input, 10 output, 110 total, cost 0.0015), and registers the result with `pi.registerProvider(createProvider(...))`. The same file loads in-process (via `additionalExtensionPaths`) and in a subprocess (via `-e`). Probed: `docs/probes/scripted-model.ts`. Model id: `scripted/scripted-1`.

2. **An SDK session can silently use a real, paid model.** `createAgentSession` chooses the model before the extension's provider is used, and ignores `defaultProvider: "scripted"` in in-memory settings. It then falls back to the first model that has credentials, which here was `anthropic/claude-opus-5-5` through `ANTHROPIC_API_KEY`. One probe made a real call this way (2,600 tokens, under $0.02). **Proposal:** `runSdkSession` (a) deletes every `*_API_KEY` / `*_TOKEN` provider variable from the environment it uses, (b) calls `session.setModel(session.modelRuntime.getModel("scripted", "scripted-1"))` after `bindExtensions`, and (c) fails the test if `session.model.provider !== "scripted"` before the first prompt. `runPiCli` also scrubs the environment.

3. **The `pi` subprocess hangs if stdin is an open pipe.** pi reads piped stdin and puts it before the first prompt, so it waits for end of input. **Proposal:** `runPiCli` spawns with stdin set to `"ignore"` (or `< /dev/null`). Probed.

4. **A command that starts a run does not get that run in print or JSON mode (affects Step 4's L3 test and every L3 `/step` test).** In `--mode json`, `/probe-cmd send` runs its handler, and the handler's `pi.sendUserMessage()` fires `input`. The process then exits and aborts the run before the model is called (`agent_settled.aborted = true`). `await ctx.waitForIdle()` inside the handler returns at once, because the run has not started yet. Commands that do not start a run, such as `/plan-new`, work in JSON mode. **Proposal:** L3 tests of commands that only change files (such as `/plan-new`) use JSON mode. L3 tests of commands that start a run use RPC mode, where this works (probed). Alternatively they can pass a second CLI prompt; pi accepts several prompts in one call (probed).

5. **In the SDK, `session.prompt("/step ...")` resolves before the run the command started.** `pi.sendUserMessage()` returns `void` and starts the run asynchronously. **Proposal:** `runSdkSession` exposes `promptAndSettle(text)`. It subscribes to session events before prompting, sends the prompt, and waits for the next `agent_settled` (with a timeout) when the prompt was a command that started a run. The headless runner does not call slash commands. It calls the core functions directly, then calls `session.prompt(stepPrompt)` itself, which resolves after the run.

6. **The mechanism for starting the next step (fact 7): `agent_settled` plus `pi.sendUserMessage()`.** Both mechanisms work in the SDK and in JSON mode. I chose `agent_settled` because the next step's prompt then enters as an ordinary user message, exactly as `/step` sends it. `before_agent_start` sees `messageType: "user"`, and the template has one delivery path. `agent_before_settle` would inject a `custom_message` instead, which takes a second path. In the SDK, `session.prompt()` resolved only after the continued run had also settled (probed).

7. **An abort produces no `input` event.** It appears only as `agent_settled` with `aborted: true` (an `agent_end` comes first, and `agent_before_settle` is skipped). Section 7.6 already says this. Confirmed, no change.

8. **Steering from the headless runner must be told apart from a person's.** `session.steer(text)` in the SDK fires `input` with `source: "interactive"` by default. **Proposal:** the runner calls `session.steer(text, undefined, { source: "rpc" })`. The extension's `input` handler records `how: "control"` when `source === "rpc"` and `ctx.mode !== "rpc"`. Otherwise it records `steer`, `follow_up`, or `idle_message` from `streamingBehavior`. Extension messages (`source: "extension"`) are ignored. Probed: `session.steer(text, undefined, { source: "rpc" })` fired `input` with `source: "rpc"` and `streamingBehavior: "steer"`.

9. **SDK sessions report `ctx.mode === "print"`** with `hasUI: false` when `bindExtensions({})` is given no UI context. The extension must not use `ctx.mode` to tell headless runs from `pi -p`. **Proposal:** the runner tells the extension it is headless explicitly, through a shared core flag or an environment variable read at load time, and the extension never infers it from `ctx.mode`.

10. **Tool parameter schemas: import `Type` from `typebox`** (version 1.3.27), not `@sinclair/typebox`. Enumerations use `StringEnum` from `@earendil-works/pi-ai`. **Proposal:** pin `typebox` to 1.3.27 in `package.json` to match pi.

11. **`pi --session <path>` needs an absolute path.** A relative path that does not resolve silently creates a new session and a stray directory in the working directory. The runner must print absolute session paths.

---

## Answers to the fifteen questions

### 1. Package name and scope

`@earendil-works/pi-coding-agent`. Its dependencies are `@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui`, and the others. pi maps the legacy `@mariozechner/*` and `@sinclair/typebox` names to the same modules for extensions loaded by pi. Read (`docs/extensions.md`, "Available Imports") and probed: the probe extensions import from `@earendil-works/*` and `typebox`.

### 2. Does `--no-extensions` keep `-e` extensions?

Yes. Docs: "Explicit `-e` paths still load". Probed: with `-ne -e probe-ext.ts`, the model's tool list was `read, bash, edit, write, harness_ping, finish`. With only the scripted model as `-e`, it was `read, bash, edit, write`.

### 3. Do extension commands run when given as the prompt?

Yes, in JSON mode, in RPC mode, and in the SDK through `session.prompt()`. Probed in all three. `input` does not fire for the command itself. **Caveat:** see change 4. In print and JSON mode, a run that the command starts with `sendUserMessage` is aborted when the process exits. In the SDK, `prompt()` returns before that run (change 5). In RPC mode, the run takes place (probed: `disposition: "handled"`, then `agent_start` and `agent_settled`).

### 4. `input` during a run and its fields

Fields (type `InputEvent`): `text`, `images?`, `source: "interactive" | "rpc" | "extension"`, and `streamingBehavior: "steer" | "followUp" | undefined`. Probed in the SDK:
- `session.steer()` during a tool call fires `input` with `streamingBehavior: "steer"`, `source: "interactive"`, and `ctx.isIdle() === false`.
- `session.followUp()` fires it with `streamingBehavior: "followUp"`.
- An idle prompt fires it with no `streamingBehavior` and `ctx.isIdle() === true`.
- `pi.sendUserMessage()` fires it with `source: "extension"`.

Typing in the interactive terminal was not probed. The docs say typed input is `source: "interactive"`. This remains a manual check in Step 6.

### 5. Does `terminate: true` end the run?

Yes, when every result in the batch is terminating. Probed: a batch with only `finish` ended the run, and the next script entry was never requested. A batch with `finish` and `harness_ping` together continued to a further model call. A blocked `tool_call` may also return `terminate: true`. The plan's response in Section 11 stands: correctness rests on the step's status.

### 6. Usage fields on an assistant message

`message.usage` has type `Usage` from pi-ai: `input`, `output`, `cacheRead`, `cacheWrite`, `cacheWrite1h?`, `reasoning?`, `totalTokens`, and `cost: { input, output, cacheRead, cacheWrite, total, billed? }`. Read in `pi-ai/dist/types.d.ts` and probed through `message_end`. Map to the log as follows: `input`→`input`, `output`→`output`, `cache_read`→`cacheRead`, `cache_write`→`cacheWrite`, `total_tokens`→`totalTokens`, `cost_usd`→`cost.total`. `stopReason` is on the message (for example `"toolUse"` or `"stop"`), and so are `model` and `provider`. An aborted turn produces an assistant `message_end` with zero usage.

### 7. How to start the next step

Both mechanisms work; I chose `agent_settled` plus `pi.sendUserMessage()` (change 6). Probed in the SDK and in JSON mode. `agent_settled` fires with `ctx.isIdle() === true`. A run requested inside it starts after every settled handler finishes. `agent_before_settle` returning `{ entries: [custom_message], continue: true }` also caused exactly one further run. Both need a guard; the plan's "only directly after a pass" condition is that guard.

### 8. `ctx.hasUI` in an SDK session; what dialogs return

`hasUI === false` and `ctx.mode === "print"` when no UI context is bound. Dialogs return at once: `select` gives `undefined`, `confirm` gives `false`, and `input` gives `undefined` (probed). In RPC mode, `hasUI === true`, `mode === "rpc"`, and `select`, `confirm`, and `input` arrive as `extension_ui_request` records on stdout. A client answers with `extension_ui_response` (`value` or `confirmed`). Probed with `docs/probes/rpc-probe.mjs`: the extension received `"b"`, `true`, and `"typed"`. **Section 9.2's question:** testing dialogs through RPC is practical, about 40 lines of client code.

### 9. Can the CLI open a session file the SDK created?

Yes. `SessionManager.create(cwd, dir)` wrote a file, and `pi --session <absolute path> "continue please"` loaded it. The model's next request held the earlier `user, assistant, toolResult, assistant` messages plus the new user message, and pi appended to the same file. Use absolute paths (change 11).

### 10. How the scripted model is built

Option 1, a test provider shipped in pi-ai: `createFauxCore` / `fauxProvider`, with `fauxAssistantMessage`, `fauxToolCall`, and `fauxText`. It needs a wrapper to fix usage (change 1). Option 2 (a custom `streamSimple`) is not needed. No third-party harness is needed. The scripted model records every request through a response factory, which receives the `TranscriptContext`. `getCurrentSystemPrompt(messages)` and `getCurrentTools(messages)` from pi-ai pull the system prompt and tool list out of it. When the script runs out, the model returns `SCRIPT_EXHAUSTED` once, and after that the faux core returns an error message ("No more faux responses queued").

### 11. Temporary configuration directory

`PI_CODING_AGENT_DIR` (default `~/.pi/agent`). Also `PI_CODING_AGENT_SESSION_DIR` or `--session-dir` for sessions, and `PI_OFFLINE=1` or `--offline`. Read in `docs/environment-variables.md`. Probed: with `PI_CODING_AGENT_DIR` set to a temporary directory, pi created `auth.json` and `models-store.json` there and nothing in `~/.pi`. In the SDK, pass `agentDir` to both `DefaultResourceLoader` and `createAgentSession`. Credentials still come from environment variables, so scrub them (change 2).

### 12. Built-in limits on turns, tokens, cost, or time

None. `pi --help` and `docs/settings.md` contain no turn, token, cost, or wall-clock limit. The only related settings are `retry.maxRetries` (default 3), `retry.provider.*`, `httpIdleTimeoutMs`, and `thinkingBudgets` (per-request reasoning tokens). The extension must supply budgets, as planned.

### 13. Blocking a call from `tool_call`; input of built-in `edit` and `write`

Return `{ block: true, reason?: string, terminate?: boolean }`. Inputs (probed):
- `write`: `{ path, content }`
- `edit`: `{ path, edits: [{ oldText, newText }] }`
- `read`: `{ path, offset?, limit? }`
- `bash`: `{ command, timeout? }`

Use `isToolCallEventType("edit", event)` to narrow the type. The path may carry a leading `@` from some models; built-in tools strip it, so the guard should too. It should also resolve the path against `ctx.cwd`. Probed: a blocked `write` left the file unchanged. `tool_execution_end` had `isError: true`, the result text was the reason, and there was no `durationMs`. `tool_result` did not fire for the blocked call. A sibling call in the same batch still ran.

### 14. How a command handler starts a run

`pi.sendUserMessage(content, { deliverAs?, expandPromptTemplates? })` returns `void`. While streaming, `deliverAs: "steer" | "followUp"` is required; without it pi reports an extension error. Probed: the run starts in RPC mode, in the SDK (asynchronously, change 5), and from `agent_settled`. It is aborted in JSON and print mode when the command was the last prompt (change 4). `ReplacedSessionContext.sendUserMessage` (only inside `withSession`) returns a `Promise`.

### 15. How an abort appears to an extension

`agent_end`, then `agent_settled` with `aborted: true`. `agent_before_settle` is skipped. The running tool's `signal` is aborted. The aborted turn's assistant message has zero usage. Probed with `session.abort()` during the `slow` tool.

---

## Other facts the steps will need

- **Event order for a tool call** (probed): `tool_execution_start`, then `tool_call`, then `tool_result`, then `tool_execution_end`. `tool_execution_end` carries `durationMs` when the tool ran. Join start and end by `toolCallId`. Tool call ids from the faux core look like `tool:<ms>:<random>`.
- **Event order for a run** (probed): `input`, `agent_start`, then per turn the assistant `message_end` and tool events, then `agent_end`, `agent_before_settle`, `agent_settled`.
- **`AgentSession.dispose()` does not emit `session_shutdown`** (found in Step 3, read in `agent-session.js` and confirmed by a failing test). Only `AgentSessionRuntime.dispose()` and session replacement emit it, after `session.abort()`. A host that uses `createAgentSession` directly must call `await session.abort()`, then `await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })`, then `session.dispose()`. The test rig does this. The Step 11 runner must do the same, or use `createAgentSessionRuntime`.
- **`session_start.reason`** is `"startup"` for both CLI and SDK starts. **`session_shutdown.reason`** is `"quit"` at process exit. `ctx.sessionManager.getSessionId()` and `getSessionFile()` give the session id and file (the file is `undefined` for `--no-session` and in-memory sessions).
- **System prompt line:** `before_agent_start` can return `{ systemPrompt }`. The docs prefer editing `event.systemPromptOptions.sections` or `promptGuidelines`, which pi diffs and patches without breaking the prompt cache. Step 4 should use a custom `sections` entry for the active-step line. Not yet probed.
- **Tool results:** a tool signals failure by throwing or by returning `isError: true`. Returning `isError: true` keeps `details`. `details` must have the same type across all results of one tool.
- **Parallel tool execution is the default.** `submit`, `report_blocked`, and procedure tools that share state should set `executionMode: "sequential"`.
- **`pi.exec(command, args, options)`** exists, but the script runner lives in `core/` and must not import pi, so it uses `node:child_process` directly.
- **Extensions load through jiti**, so the package needs no build step for pi to load it. `tsc --noEmit` is used only for type checking.
- **Project trust:** extensions given with `-e` load without a trust prompt (probed: no prompt in JSON or SDK mode). Loading through a project's `.pi/settings.json` requires the project to be trusted, or `-a` / `--approve`.
- **Registry access:** `npm view` reached the registry from this machine (vitest 5.1.0 is the latest; pi itself uses 4.1.12). Step 1 needs `npm install`.

## Found in Step 5

- **Tools get a full context.** `ExtensionToolContext` extends `ExtensionContext`, so a tool's `execute` has `ctx.hasUI` and `ctx.ui.confirm(title, message)`. `submit` uses this to ask about a plan edited by hand. Read in `dist/core/extensions/types.d.ts`.
- **`isToolCallEventType(name, event)`** only compares `event.toolName === name` (read in `dist/core/extensions/types.js`). Calls that another tool makes through `ctx.executeTool` also fire `tool_call` (with `parentToolCallId`), so the guard sees nested `edit` and `write` calls too. Read in the types; not probed.
- **`terminate: true` from `submit` ends the run** in an SDK session: the next script entry was never requested (test/sdk/completion.test.ts). This confirms fact 5 for a tool registered by the harness.
- **A blocked built-in `edit`** returns the block reason to the model as an error tool result, and the file stays unchanged (test/sdk/completion.test.ts).

## Found in Step 6

- **Extension commands run at once, even during a run.** `AgentSession.prompt("/cmd ...")` calls the command's handler before any check for streaming (read in `dist/core/agent-session.js`, `prompt()`; the comment says "execute immediately, even during streaming"). Probed: `/abandon` sent while the `gate` test tool was running aborted the run and ended the step (test/sdk/interruptions.test.ts). So `/abandon` during a run is tested at level 2.
- **An abort in the middle of a tool call still emits `tool_execution_end`** for every call that had `tool_execution_start`. pi-agent-core emits the end after `execute()` returns or throws (errors are caught), in both the sequential and the parallel path; calls not yet started get no start either (read in `pi-agent-core/dist/agent-loop.js`). Probed: an aborted `gate` call is logged as one `tool_call` with a `duration_ms`. So the `pending` map in `logging.ts` does not leak; it is also cleared at `agent_settled` as a guard. A tool that ignores its abort signal and never returns would hold the run open; that is the tool's fault, and the script runner does honor the signal.
- **`agent_settled` handlers run before `ctx.waitForIdle()` returns** (read in `_emitAgentSettled`: the extension event is awaited, then the idle wait resolves). An abort that `/abandon` issues is therefore seen by the `agent_settled` handler while the step is still active. The harness marks its own abort (`state.ownAbort`) so it is not logged as an interruption.
- **The window after `/step` (change 4) is reachable from the SDK.** `await session.prompt("/step ...")` followed at once by `await session.prompt("/abandon ...")` ended the step, and before the fix the step's run then reached the model with the step prompt. In the probe, the run began (`before_agent_start` fired, `ctx.isIdle()` became false) while `/abandon` was awaiting its plan read, before it ended the step. Closed in two places: `/abandon` checks `ctx.isIdle()` again after ending the step and aborts a run that began meanwhile (probed: no model request); and `before_agent_start` aborts a run whose prompt is the step prompt of a step that has ended (the other order; tested with the stub only). pi's code says an abort during `before_agent_start` stops the run at `agent_start`, before the first request (read, comment in `_handleAgentEvent`). Typing in the terminal interface cannot hit this window, which lasts a few promise turns; an RPC client sending two commands back to back probably can (not probed). Still open: `/abandon` followed by another `/step` inside the same window would let the first step's prompt run under the second step. Not handled.
- **Nested tool calls** have ids `<parent id>/<n>` and carry `parentToolCallId` on `tool_execution_*` and `tool_call` (read in `dist/core/extensions/types.d.ts`). The `tool_call` log record has `parent` (null at top level). Step-record counts do not use `tool_call` records, so nesting neither hides nor double-counts anything (see `src/core/steps.ts`).
- **Node runs `src/bin/harness-report.ts` directly.** Node 22.18 and later strip TypeScript types by default; the L3 test runs it with `process.execPath` (Node 22.20.0 here). Node's documentation says it does not strip types for files under `node_modules` (not checked here), so an installed copy of this package would need a build step or a JavaScript wrapper. Not needed while the package is used from its own checkout.

## Found in Step 7

- **Tools registered in `session_start` reach the model.** The harness registers procedure tools there, because the project root (and so `harness.json`) is known only then. They appear in the first request's tool list in the SDK (test/sdk/procedures.test.ts) and in the CLI with `-e` (test/cli/procedures.test.ts).
- **pi 1.5.1 has no `unregisterTool`.** `ExtensionAPI` has `unregisterProvider`, `unregisterMcpServer`, and `unregisterVirtualModel`, but nothing for tools (read in `dist/core/extensions/types.d.ts`). Registering the same name again from the same extension replaces the definition (`extension.tools.set` in `dist/core/extensions/loader.js`). `pi.setActiveTools()` takes a tool out of the set declared to the model; a model that still calls it gets "Tool <name> not found" (`prepareToolCall` in `pi-agent-core/dist/agent-loop.js` looks only at the active tools; read, not probed). A name that was already activated on registration is not activated again by a second `registerTool` (`_refreshToolRegistry` in `dist/core/agent-session.js`), so an extension that deactivated it must put it back itself.
- **A second `session_start` on the same extension instance should not happen in 1.5.1.** `/new`, `/resume`, `/fork`, and `/reload` all reload and rebind extensions, so a fresh instance gets the new `session_start` (read in `docs/extensions.md`, sections on `session_start`, `session_before_switch`, `session_before_fork`, and `ctx.reload()`). The harness handles a second one anyway (it deactivates the earlier project's procedures, and those tools refuse to run); this is tested with the stub only.
- **An extension tool with a built-in's name replaces the built-in without a warning** (`docs/extensions.md`, "Overriding Built-in Tools"). `pi.getAllTools()` lists every built-in that `--tools` allows (including inactive ones such as `grep`, `find`, `ls`) and other extensions' tools, each with `sourceInfo.path` (`builtin:<name>` for built-ins). The harness checks procedure names against this list at `session_start` and skips a clashing procedure. Probed: a procedure named `read` was not registered and `read` stayed the built-in (test/sdk/procedures.test.ts). A tool that another extension registers after `session_start` is not checked.
- **pi validates tool arguments against the schema before `execute`** (`validateToolArguments`, called from `prepareToolCall` in `pi-agent-core/dist/agent-loop.js`; read). The harness therefore does not validate procedure arguments itself and never relies on typebox `Value.Errors` (which returns at most 8 errors).
- **Change to fact 10: enumerations use `Type.String({ enum })`, not pi-ai's `StringEnum`.** `@earendil-works/pi-ai` is only a dev dependency of this package. `Type.String({ enum: [...] })` from typebox 1.3.27 produces exactly `{ type: "string", enum: [...] }`, the schema `StringEnum` documents (read in `pi-ai/dist/utils/string-enum.d.ts`; output checked).
- **`tool_execution_end.durationMs` is absent when the tool did not run** (documented in the type), for example when a guard blocked it or its arguments failed validation. **pi's `edit` and `write` check for an abort after writing the file** (`dist/core/tools/edit.js` and `write.js`), so an error result does not prove the file is unchanged. The `requires` tracker therefore counts an `edit` or `write` that ran, with or without an error, and ignores one that did not run.
