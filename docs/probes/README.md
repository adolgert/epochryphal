# Step 0 probes

Throwaway probes used to verify `docs/pi-facts.md` against pi 1.5.1. Kept so the facts can be re-checked after a pi upgrade. They are not part of the package or the test suite.

Setup (once): in a scratch directory, copy these files, create `proj/` and `cfg/`, and symlink pi's packages so the `.mjs` scripts can import them:

```sh
G=$(npm root -g)/@earendil-works/pi-coding-agent
mkdir -p node_modules/@earendil-works proj cfg
ln -s $G node_modules/@earendil-works/pi-coding-agent
ln -s $G/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
ln -s $G/node_modules/typebox node_modules/typebox
echo '{"type":"module"}' > package.json
export PI_CODING_AGENT_DIR=$PWD/cfg
unset ANTHROPIC_API_KEY GEMINI_API_KEY OPENAI_API_KEY   # never let a probe reach a real model
```

- `scripted-model.ts`: scripted model extension (faux core plus fixed usage). Reads `HARNESS_TEST_SCRIPT`.
- `probe-ext.ts`: logs pi events to `PROBE_LOG`; tools `harness_ping`, `finish` (terminating), `slow` (300 ms); commands `/probe-cmd`, `/probe-dialog`; `PROBE_CONTINUE=settled|before_settle` tests continuation.
- `sdk-probe.mjs <name> '<script json>' [file|mem] [prompt]`: in-process session. Names `steer`, `followup`, and `abort` act during the run.
- `rpc-probe.mjs`: RPC mode, answers dialogs.

CLI probe: `cd proj && pi --no-extensions -e ../probe-ext.ts -e ../scripted-model.ts --model scripted/scripted-1 --mode json --no-context-files --no-skills --no-prompt-templates --offline --no-session "hello" < /dev/null`

Other probes:

- `typebox-record.mjs`: `Value.Errors` does report errors inside `Type.Record` entries, but returns at most 8 errors per value. Run from the repository root.
