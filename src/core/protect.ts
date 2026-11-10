// Protected files (plan Section 7.4): glob matching, the guard's decision, and the two questions
// asked of git. The harness detects changes to protected files; it does not prevent them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { draftsDir } from "./lessons.ts";

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

/** Whether `path` (relative to the root) lies under the lesson drafts directory. */
const isDraft = (path: string, harnessDir: string) => path.startsWith(`${draftsDir(harnessDir)}/`);

/**
 * Why the agent's edit tools may not write `path` (relative to the root), or null when they may.
 * Lesson drafts are allowed, so the agent can fill one in when a person asks; a draft has no
 * effect until a person moves it into the protected lessons directory.
 */
export function guardReason(path: string, patterns: readonly string[], harnessDir: string): string | null {
	if (path.startsWith(`${harnessDir}/plans/`)) return "plan files change only through harness commands and tools";
	if (path.startsWith(`${harnessDir}/log/`)) return "the harness log is written only by the harness";
	if (isDraft(path, harnessDir)) return null;
	const pattern = patterns.find((p) => globToRegExp(p).test(path));
	return pattern === undefined ? null : `it matches the protected pattern ${pattern}`;
}

function git(root: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
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
 * Lesson drafts never count: the harness writes them itself when a step passes.
 */
export function changedProtected(root: string, base: string, patterns: readonly string[], harnessDir: string): string[] {
	// --no-renames: a file moved out of a protected directory must show under its old name too.
	const changed = nulList(git(root, ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--relative", "-z", base, "--"]));
	const untracked = nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
	return [...new Set([...changed, ...untracked])].filter((p) => !isDraft(p, harnessDir) && matchesAny(p, patterns)).sort();
}

/**
 * A hash of the working tree's content under `root`, for the stall rule: equal hashes mean the
 * same files hold the same bytes. It covers every file that differs from commit `base` (committed
 * since or not, with its mode, or as deleted) and every untracked file that git does not ignore.
 * The harness's own plans/, log/, and lessons/drafts/ are left out, because the harness writes there itself.
 *
 * Cost: one `git diff` and one `git ls-files`, which stat every tracked file and walk untracked
 * directories, then reading each changed or untracked file in full. Nothing is written to git.
 */
export function treeFingerprint(root: string, base: string, harnessDir: string): string {
	const pathspec = ["--", ".", `:(exclude)${harnessDir}/plans`, `:(exclude)${harnessDir}/log`, `:(exclude)${draftsDir(harnessDir)}`];
	// --raw -z gives ":oldmode newmode oldsha newsha status\0path\0" per file.
	const raw = nulList(git(root, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--relative", base, ...pathspec]));
	const entries: string[] = [];
	for (let i = 0; i + 1 < raw.length; i += 2) {
		const [, newMode = "", , , status = ""] = raw[i]!.split(" ");
		entries.push(`${raw[i + 1]}\0${newMode}\0${status === "D" ? "deleted" : contentHash(join(root, raw[i + 1]!))}`);
	}
	for (const path of nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]))) {
		entries.push(`${path}\0untracked\0${contentHash(join(root, path))}`);
	}
	return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

/** sha256 of a file's bytes, of a symbolic link's target, or "missing". */
function contentHash(path: string): string {
	try {
		const target = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
		return createHash("sha256").update(target).digest("hex");
	} catch {
		return "missing";
	}
}
