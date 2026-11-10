// Lessons (plan Section 7.10): loaded once per session, appended to failed procedure results
// through pi's tool_result event, and drafted when a step passes.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { type Clock, systemClock } from "../core/clock.ts";
import { type HarnessConfig, loadConfig } from "../core/config.ts";
import { type Lesson, lessonBlock, loadLessons, matchLessons, writeDrafts } from "../core/lessons.ts";
import { readEvents } from "../core/log.ts";
import { currentCommit } from "../core/protect.ts";
import { attemptEvents } from "../core/steps.ts";
import type { ProceduresApi } from "./procedures.ts";
import { type ActiveStep, type HarnessState, report, say } from "./state.ts";

export interface LessonsApi {
	/** Write drafts from the events of a step attempt that just passed. Never throws. */
	draft(step: ActiveStep): void;
}

export function registerLessons(pi: ExtensionAPI, state: HarnessState, procedures: ProceduresApi, clock: Clock = systemClock): LessonsApi {
	// Frozen at session_start, so a run always sees one fixed set (Section 7.10).
	let lessons: Lesson[] = [];
	let config: HarnessConfig | null = null;

	pi.on("session_start", async () => {
		lessons = [];
		config = null;
		if (state.root === null) return;
		try {
			config = loadConfig(state.root, state.harnessDir);
		} catch {
			return; // Procedures report a bad harness.json; without it there are no procedure tools.
		}
		const dir = join(state.root, state.harnessDir, "lessons");
		const loaded = loadLessons(dir, config.lessons.max_chars);
		lessons = loaded.lessons;
		for (const problem of loaded.problems) report(state, `lesson not loaded: ${problem}. The other lessons are loaded.`, "warning");
	});

	// The text matched is the result the model sees: the script's summary, cut to
	// max_summary_chars, which also bounds the time a pattern can take.
	pi.on("tool_result", async (event) => {
		const proc = procedures.takeFailed(event.toolCallId);
		if (!proc?.lesson_trigger || !config || lessons.length === 0) return;
		const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		const chosen = matchLessons(lessons, proc.name, text, config.lessons);
		if (chosen.length === 0) return;
		for (const l of chosen) state.log?.write("lesson_injected", { lesson_id: l.id, tool: proc.name });
		return { content: [...event.content, { type: "text" as const, text: `\n\n${chosen.map(lessonBlock).join("\n\n")}` }] };
	});

	return {
		draft(step) {
			try {
				if (state.root === null || !state.log) return;
				const cfg = loadConfig(state.root, state.harnessDir);
				const triggers = new Set(cfg.procedures.filter((p) => p.lesson_trigger).map((p) => p.name));
				let head = "unknown";
				try {
					head = currentCommit(state.root).slice(0, 12);
				} catch {
					// Recorded as unknown.
				}
				const { written, problems } = writeDrafts({
					root: state.root,
					harnessDir: state.harnessDir,
					events: attemptEvents(readEvents(state.log.path), step),
					ref: step,
					triggers,
					commits: `${step.commit?.slice(0, 12) ?? "unknown"}..${head}`,
					date: new Date(clock.now()).toISOString().slice(0, 10),
				});
				for (const path of written) state.log.write("lesson_drafted", { path });
				for (const problem of problems) report(state, `${problem}. Step ${step.step} still passed.`, "warning");
				if (written.length > 0) say(state, `Lesson drafts to review: ${written.join(", ")}. Fill in pattern, Cause, and Workaround, then move a draft to ${state.harnessDir}/lessons/ to use it.`);
			} catch (e) {
				report(state, `lesson drafting failed: ${(e as Error).message}. Step ${step.step} still passed.`, "warning");
			}
		},
	};
}
