// Protected files (plan Section 7.4): glob matching, the guard's decision, and the two questions
// asked of git. The harness detects changes to protected files; it does not prevent them.
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Git is missing, the project is not a repository, or a git command failed. */
export class GitError extends Error {
	override name = "GitError";
}

/**
 * A glob pattern as a regular expression over a path relative to the project root, with "/"
 * between parts. `*` matches within one part, `?` matches one character other than "/", `**`
 * matches across parts, and `**` followed by "/" also matches no parts. Dot files are not special. A pattern
 * matches the whole path: `tests/**` matches everything under tests/, `*.txt` only top-level files.
 */
export function globToRegExp(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; ) {
		if (pattern.startsWith("**/", i)) [re, i] = [re + "(?:.*/)?", i + 3];
		else if (pattern.startsWith("**", i)) [re, i] = [re + ".*", i + 2];
		else if (pattern[i] === "*") [re, i] = [re + "[^/]*", i + 1];
		else if (pattern[i] === "?") [re, i] = [re + "[^/]", i + 1];
		else [re, i] = [re + pattern[i]!.replace(/[.+^${}()|[\]\\]/g, "\\$&"), i + 1];
	}
	return new RegExp(`^${re}$`);
}

export const matchesAny = (path: string, patterns: readonly string[]): boolean => patterns.some((p) => globToRegExp(p).test(path));

/**
 * A tool's target path as a path relative to the project root, or null when it lies outside the
 * root. Strips the leading "@" some models add, as pi's built-in tools do.
 */
export function projectPath(root: string, cwd: string, path: string): string | null {
	const rel = relative(root, resolve(cwd, path.replace(/^@/, "")));
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.split(sep).join("/");
}

/** Why the agent's edit tools may not write `path` (relative to the root), or null when they may. */
export function guardReason(path: string, patterns: readonly string[], harnessDir: string): string | null {
	if (path.startsWith(`${harnessDir}/plans/`)) return "plan files change only through harness commands and tools";
	if (path.startsWith(`${harnessDir}/log/`)) return "the harness log is written only by the harness";
	const pattern = patterns.find((p) => globToRegExp(p).test(path));
	return pattern === undefined ? null : `it matches the protected pattern ${pattern}`;
}

function git(root: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		const err = e as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === "ENOENT") throw new GitError("git is not installed or not on the PATH");
		throw new GitError(`git ${args[0]} failed in ${root}: ${String(err.stderr || err.message).trim()}`);
	}
}

const nulList = (out: string) => out.split("\0").filter((p) => p !== "");

/** The commit HEAD points at. The harness needs a git repository with at least one commit. */
export function currentCommit(root: string): string {
	try {
		return git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	} catch (e) {
		throw new GitError(`cannot read the current commit (${(e as Error).message}); the harness needs the project to be a git repository with at least one commit`);
	}
}

/**
 * Protected files that differ from commit `base` (committed or not), or are untracked and not
 * ignored. Paths are relative to `root`, sorted. With `base` = HEAD this is "uncommitted changes".
 */
export function changedProtected(root: string, base: string, patterns: readonly string[]): string[] {
	// --no-renames: a file moved out of a protected directory must show under its old name too.
	const changed = nulList(git(root, ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--relative", "-z", base, "--"]));
	const untracked = nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
	return [...new Set([...changed, ...untracked])].filter((p) => matchesAny(p, patterns)).sort();
}
