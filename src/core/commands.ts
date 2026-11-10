// Parsing the arguments of the person's slash commands (plan Section 7.1).

export class CommandError extends Error {
	override name = "CommandError";
}

const words = (text: string) => text.trim().split(/\s+/).filter((w) => w !== "");

export interface StepArgs {
	kind: string;
	check_args: string[];
	goal: string;
}

/**
 * `<kind> [check args...] -- <goal text>`. Without `--`, all text after the kind is the goal and
 * there are no check arguments.
 */
export function parseStepArgs(text: string, kinds: readonly string[]): StepArgs {
	const trimmed = text.trim();
	const usage = "usage: <kind> [check args...] -- <goal text>";
	const [kind] = words(trimmed);
	if (kind === undefined) throw new CommandError(`${usage}; kinds: ${kinds.join(", ")}`);
	if (!kinds.includes(kind)) throw new CommandError(`unknown kind "${kind}"; kinds: ${kinds.join(", ")}`);
	const rest = trimmed.slice(kind.length);
	const sep = rest.search(/(^|\s)--(\s|$)/);
	const [check_args, goal] =
		sep < 0 ? [[], rest.trim()] : [words(rest.slice(0, sep)), rest.slice(sep).replace(/^\s*--/, "").trim()];
	if (goal === "") throw new CommandError(`the step needs a goal; ${usage}`);
	return { kind, check_args, goal };
}

/** `<first word> <rest of the text>`, both required. */
export function parseWordAndText(text: string, usage: string): { word: string; text: string } {
	const trimmed = text.trim();
	const [word] = words(trimmed);
	const rest = word === undefined ? "" : trimmed.slice(word.length).trim();
	if (word === undefined || rest === "") throw new CommandError(`usage: ${usage}`);
	return { word, text: rest };
}
