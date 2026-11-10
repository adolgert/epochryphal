#!/usr/bin/env node
// harness-run --project <dir> --plan <plan_id> --model <provider/id> [--steps <n>]
//             [--session-mode fresh_per_step|continue] [--session-dir <dir>] [--extension <path>]...
// Runs the plan's pending steps with nobody present (plan Section 7.9).
import { parseArgs } from "node:util";
import { runHeadless, type SessionMode } from "../runner/run.ts";

const USAGE =
	"usage: harness-run --project <dir> --plan <plan_id> --model <provider/id> [--steps <n>] [--session-mode fresh_per_step|continue] [--session-dir <dir>] [--extension <path>]...";
const MODES: SessionMode[] = ["fresh_per_step", "continue"];

async function main(argv: string[]): Promise<number> {
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				project: { type: "string" },
				plan: { type: "string" },
				model: { type: "string" },
				steps: { type: "string" },
				"session-mode": { type: "string" },
				"session-dir": { type: "string" },
				extension: { type: "string", multiple: true },
			},
		}));
	} catch (e) {
		process.stderr.write(`harness-run: ${(e as Error).message}\n${USAGE}\n`);
		return 1;
	}
	const bad = (message: string) => (process.stderr.write(`harness-run: ${message}\n${USAGE}\n`), 1);
	if (!values.project || !values.plan || !values.model) return bad("--project, --plan, and --model are required");
	if (values.steps !== undefined && !/^[1-9]\d*$/.test(values.steps)) return bad(`--steps must be a whole number, 1 or more; got "${values.steps}"`);
	const mode = values["session-mode"];
	if (mode !== undefined && !MODES.includes(mode as SessionMode)) return bad(`--session-mode must be ${MODES.join(" or ")}; got "${mode}"`);
	return runHeadless({
		project: values.project,
		plan: values.plan,
		model: values.model,
		steps: values.steps === undefined ? undefined : Number(values.steps),
		sessionMode: mode as SessionMode | undefined,
		sessionDir: values["session-dir"],
		extensions: values.extension,
	});
}

process.exitCode = await main(process.argv.slice(2));
