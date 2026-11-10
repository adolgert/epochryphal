// Level 1: parsing the arguments of slash commands.
import { describe, expect, it } from "vitest";
import { parseStepArgs, parseWordAndText } from "../../src/core/commands.ts";

const kinds = ["restructure", "offload", "measure"];

describe("parseStepArgs", () => {
	it("splits check arguments from the goal at --", () => {
		expect(parseStepArgs("offload R17 R18 -- Port both regions", kinds)).toEqual({
			kind: "offload",
			check_args: ["R17", "R18"],
			goal: "Port both regions",
		});
	});

	it("takes all text after the kind as the goal when there is no --", () => {
		expect(parseStepArgs("measure Profile the sample", kinds)).toEqual({ kind: "measure", check_args: [], goal: "Profile the sample" });
	});

	it("accepts -- right after the kind", () => {
		expect(parseStepArgs("measure -- Profile it", kinds)).toEqual({ kind: "measure", check_args: [], goal: "Profile it" });
	});

	it("keeps a -- inside the goal text, and dashes inside words", () => {
		expect(parseStepArgs("offload R-17 -- Port it -- carefully", kinds)).toEqual({
			kind: "offload",
			check_args: ["R-17"],
			goal: "Port it -- carefully",
		});
	});

	it("refuses an unknown kind and lists the known ones", () => {
		expect(() => parseStepArgs("tune -- Make it fast", kinds)).toThrow('unknown kind "tune"; kinds: restructure, offload, measure');
	});

	it("refuses an empty goal and an empty command", () => {
		expect(() => parseStepArgs("offload R17 --", kinds)).toThrow(/the step needs a goal/);
		expect(() => parseStepArgs("measure", kinds)).toThrow(/the step needs a goal/);
		expect(() => parseStepArgs("  ", kinds)).toThrow(/usage: <kind>/);
	});
});

describe("parseWordAndText", () => {
	it("splits the first word from the rest", () => {
		expect(parseWordAndText(" e1  Run the solve on the GPU ", "u")).toEqual({ word: "e1", text: "Run the solve on the GPU" });
	});

	it("requires both parts", () => {
		expect(() => parseWordAndText("e1", "/plan-new <plan_id> <goal>")).toThrow("usage: /plan-new <plan_id> <goal>");
		expect(() => parseWordAndText("", "u")).toThrow("usage: u");
	});
});
