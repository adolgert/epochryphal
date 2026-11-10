// A stand-in for the harness process: runs one project script with runScript and prints the outcome.
// Usage: node run-script-process.ts <project dir> <script name>
// Tests send it signals to check that running scripts are terminated when the harness goes away.
import { join } from "node:path";
import { runScript } from "../../src/core/script.ts";

const [dir, name] = process.argv.slice(2);
if (!dir || !name) throw new Error("usage: run-script-process.ts <project dir> <script name>");
const outcome = await runScript(
	[`harness/scripts/${name}`],
	{ params: {}, plan: null, step: null, attempt: null, kind: null },
	{ cwd: dir, name, timeoutMs: 60_000, maxSummaryChars: 2000, outputDir: join(dir, "harness/log/outputs") },
);
process.stdout.write(JSON.stringify(outcome) + "\n");
