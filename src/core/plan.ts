// Plans (plan Section 5.2): the plan file for one epoch, its step transitions, and the store on disk.
// Transition functions are pure: they take a plan and return a changed copy, or throw PlanError.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Budget } from "./config.ts";

export type StepStatus = "pending" | "active" | "passed" | "blocked" | "abandoned" | "stopped";
export type StepOutcome = "passed" | "blocked" | "abandoned" | "stopped";
export type ExitDecision = "keep" | "revert" | "continue";

export interface Step {
	id: string;
	kind: string;
	goal: string;
	check_args: string[];
	/** "user", or "proposal:<id>". */
	origin: string;
	status: StepStatus;
	attempt: number;
	/** Overrides single fields of the kind's budget. */
	budget?: Partial<Budget>;
	/** Why the step ended as blocked, abandoned, or stopped. */
	reason?: string;
}

export interface Proposal {
	id: string;
	kind: string;
	goal: string;
	check_args: string[];
	rationale: string;
	proposed_in_step: string | null;
	state: "open" | "accepted" | "rejected";
	reason?: string;
}

export interface Plan {
	plan_id: string;
	goal: string;
	created_at: string;
	steps: Step[];
	proposals: Proposal[];
	exit: { decision: ExitDecision; note: string; at: string } | null;
}

export class PlanError extends Error {
	override name = "PlanError";
}

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATUSES: StepStatus[] = ["pending", "active", "passed", "blocked", "abandoned", "stopped"];
const RETRYABLE: StepStatus[] = ["blocked", "abandoned", "stopped"];
const PROPOSAL_STATES: Proposal["state"][] = ["open", "accepted", "rejected"];
const DECISIONS: ExitDecision[] = ["keep", "revert", "continue"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function newPlan(planId: string, goal: string, now: Date): Plan {
	if (!PLAN_ID.test(planId)) {
		throw new PlanError(`plan id "${planId}" must start with a letter or digit and use only letters, digits, ".", "_" and "-"`);
	}
	if (goal.trim() === "") throw new PlanError("the plan needs a goal");
	return { plan_id: planId, goal: goal.trim(), created_at: now.toISOString(), steps: [], proposals: [], exit: null };
}

export const activeStep = (plan: Plan): Step | undefined => plan.steps.find((s) => s.status === "active");
export const firstPending = (plan: Plan): Step | undefined => plan.steps.find((s) => s.status === "pending");

function findStep(plan: Plan, id: string): Step {
	const step = plan.steps.find((s) => s.id === id);
	if (!step) throw new PlanError(`plan ${plan.plan_id} has no step ${id}`);
	return step;
}

function requireOpen(plan: Plan): void {
	if (plan.exit) throw new PlanError(`plan ${plan.plan_id} is closed (${plan.exit.decision}); start a new plan with /plan-new`);
}

function withStep(plan: Plan, id: string, change: Partial<Step>): Plan {
	return { ...plan, steps: plan.steps.map((s) => (s.id === id ? { ...s, ...change } : s)) };
}

/** The next step id: one more than the highest number used so far. */
function nextStepId(plan: Plan): string {
	const numbers = plan.steps.map((s) => Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0));
	return `s${Math.max(0, ...numbers) + 1}`;
}

export interface NewStep {
	kind: string;
	goal: string;
	check_args?: string[];
	origin?: string;
	budget?: Partial<Budget>;
}

export function addStep(plan: Plan, spec: NewStep): { plan: Plan; step: Step } {
	requireOpen(plan);
	if (spec.goal.trim() === "") throw new PlanError("the step needs a goal");
	const step: Step = {
		id: nextStepId(plan),
		kind: spec.kind,
		goal: spec.goal.trim(),
		check_args: spec.check_args ?? [],
		origin: spec.origin ?? "user",
		status: "pending",
		attempt: 1,
		...(spec.budget ? { budget: spec.budget } : {}),
	};
	return { plan: { ...plan, steps: [...plan.steps, step] }, step };
}

function requireNoActive(plan: Plan): void {
	const active = activeStep(plan);
	if (active) throw new PlanError(`step ${active.id} is active; finish it or /abandon it first`);
}

/** pending -> active. */
export function startStep(plan: Plan, id: string): Plan {
	requireOpen(plan);
	requireNoActive(plan);
	const step = findStep(plan, id);
	if (step.status !== "pending") throw new PlanError(`step ${id} is ${step.status}, not pending`);
	return withStep(plan, id, { status: "active" });
}

/** blocked, abandoned, or stopped -> active, with the attempt raised by one. Default: the latest such step. */
export function retryStep(plan: Plan, id?: string): { plan: Plan; step: Step } {
	requireOpen(plan);
	requireNoActive(plan);
	const step = id ? findStep(plan, id) : plan.steps.findLast((s) => RETRYABLE.includes(s.status));
	if (!step) throw new PlanError("no step is blocked, abandoned, or stopped");
	if (!RETRYABLE.includes(step.status)) throw new PlanError(`step ${step.id} is ${step.status}; only a blocked, abandoned, or stopped step can be retried`);
	const { reason: _reason, ...rest } = step;
	const retried: Step = { ...rest, status: "active", attempt: step.attempt + 1 };
	return { plan: { ...plan, steps: plan.steps.map((s) => (s.id === step.id ? retried : s)) }, step: retried };
}

/** active -> passed, blocked, abandoned, or stopped. */
export function endStep(plan: Plan, id: string, outcome: StepOutcome, reason?: string): Plan {
	const step = findStep(plan, id);
	if (step.status !== "active") throw new PlanError(`step ${id} is ${step.status}, not active`);
	if (outcome !== "passed" && (reason === undefined || reason.trim() === "")) throw new PlanError(`a ${outcome} step needs a reason`);
	return withStep(plan, id, outcome === "passed" ? { status: outcome } : { status: outcome, reason: reason!.trim() });
}

export function closePlan(plan: Plan, decision: ExitDecision, note: string, now: Date): Plan {
	requireOpen(plan);
	const active = activeStep(plan);
	if (active) throw new PlanError(`step ${active.id} is active; finish it or /abandon it before closing the plan`);
	if (note.trim() === "") throw new PlanError("closing a plan needs a note");
	return { ...plan, exit: { decision, note: note.trim(), at: now.toISOString() } };
}

export const MAX_OPEN_PROPOSALS = 10;

function findProposal(plan: Plan, id: string): Proposal {
	const proposal = plan.proposals.find((p) => p.id === id);
	if (!proposal) throw new PlanError(`plan ${plan.plan_id} has no proposal ${id}; /proposals lists the open ones`);
	return proposal;
}

function requireOpenProposal(plan: Plan, id: string): Proposal {
	requireOpen(plan);
	const proposal = findProposal(plan, id);
	if (proposal.state !== "open") throw new PlanError(`proposal ${id} is already ${proposal.state}`);
	return proposal;
}

function withProposal(plan: Plan, id: string, change: Partial<Proposal>): Plan {
	return { ...plan, proposals: plan.proposals.map((p) => (p.id === id ? { ...p, ...change } : p)) };
}

export interface NewProposal {
	kind: string;
	goal: string;
	check_args?: string[];
	rationale: string;
	proposed_in_step: string | null;
}

/** Add an open proposal. Ids are p1, p2, ...: one more than the highest number used so far. */
export function addProposal(plan: Plan, spec: NewProposal): { plan: Plan; proposal: Proposal } {
	requireOpen(plan);
	if (spec.goal.trim() === "") throw new PlanError("the proposal needs a goal");
	if (spec.rationale.trim() === "") throw new PlanError("the proposal needs a rationale: say why this step should come next");
	const open = plan.proposals.filter((p) => p.state === "open").length;
	if (open >= MAX_OPEN_PROPOSALS) {
		throw new PlanError(`plan ${plan.plan_id} already has ${open} open proposals, the most allowed; a person must accept or reject some first`);
	}
	const numbers = plan.proposals.map((p) => Number(/^p(\d+)$/.exec(p.id)?.[1] ?? 0));
	const proposal: Proposal = {
		id: `p${Math.max(0, ...numbers) + 1}`,
		kind: spec.kind,
		goal: spec.goal.trim(),
		check_args: spec.check_args ?? [],
		rationale: spec.rationale.trim(),
		proposed_in_step: spec.proposed_in_step,
		state: "open",
	};
	return { plan: { ...plan, proposals: [...plan.proposals, proposal] }, proposal };
}

/** open -> accepted, with a new pending step whose origin names the proposal. */
export function acceptProposal(plan: Plan, id: string): { plan: Plan; step: Step } {
	const p = requireOpenProposal(plan, id);
	return addStep(withProposal(plan, id, { state: "accepted" }), { kind: p.kind, goal: p.goal, check_args: p.check_args, origin: `proposal:${id}` });
}

/** open -> rejected. The reason is optional. */
export function rejectProposal(plan: Plan, id: string, reason?: string): Plan {
	requireOpenProposal(plan, id);
	const why = reason?.trim();
	return withProposal(plan, id, why ? { state: "rejected", reason: why } : { state: "rejected" });
}

/** Problems with a plan read from disk (a person may have edited it). Empty when valid. */
export function planProblems(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return ["the plan must be a JSON object"];
	const p = value as Record<string, unknown>;
	const problems: string[] = [];
	const str = (v: unknown, path: string) => typeof v === "string" || problems.push(`${path} must be a string`);
	str(p.plan_id, "plan_id");
	str(p.goal, "goal");
	str(p.created_at, "created_at");
	const strList = (v: unknown, path: string) => (Array.isArray(v) && v.every((a) => typeof a === "string")) || problems.push(`${path} must be a list of strings`);
	const oneOf = (v: unknown, allowed: readonly string[], path: string) =>
		allowed.includes(v as string) || problems.push(`${path} must be one of ${allowed.join(", ")}`);
	if (!Array.isArray(p.proposals)) problems.push("proposals must be a list");
	else {
		const proposalIds = new Set<unknown>();
		p.proposals.forEach((q: unknown, i: number) => {
			const path = `proposals[${i}]`;
			if (!isObject(q)) return void problems.push(`${path} must be an object`);
			if (proposalIds.has(q.id)) problems.push(`${path}.id "${String(q.id)}" is used twice`);
			proposalIds.add(q.id);
			for (const key of ["id", "kind", "goal", "rationale"]) str(q[key], `${path}.${key}`);
			strList(q.check_args, `${path}.check_args`);
			if (q.proposed_in_step !== null && typeof q.proposed_in_step !== "string") problems.push(`${path}.proposed_in_step must be a string or null`);
			oneOf(q.state, PROPOSAL_STATES, `${path}.state`);
			if (q.reason !== undefined) str(q.reason, `${path}.reason`);
		});
	}
	if (p.exit !== null) {
		if (!isObject(p.exit)) problems.push("exit must be null or an object");
		else {
			oneOf(p.exit.decision, DECISIONS, "exit.decision");
			str(p.exit.note, "exit.note");
			str(p.exit.at, "exit.at");
		}
	}
	if (!Array.isArray(p.steps)) return [...problems, "steps must be a list"];
	const ids = new Set<string>();
	let active = 0;
	p.steps.forEach((s: unknown, i: number) => {
		const path = `steps[${i}]`;
		if (typeof s !== "object" || s === null) return void problems.push(`${path} must be an object`);
		const step = s as Record<string, unknown>;
		str(step.id, `${path}.id`);
		str(step.kind, `${path}.kind`);
		str(step.goal, `${path}.goal`);
		str(step.origin, `${path}.origin`);
		strList(step.check_args, `${path}.check_args`);
		oneOf(step.status, STATUSES, `${path}.status`);
		if (!Number.isInteger(step.attempt) || (step.attempt as number) < 1) problems.push(`${path}.attempt must be a whole number of at least 1`);
		if (step.reason !== undefined) str(step.reason, `${path}.reason`);
		if (step.budget !== undefined) {
			if (!isObject(step.budget)) problems.push(`${path}.budget must be an object`);
			else for (const [key, v] of Object.entries(step.budget)) if (typeof v !== "number") problems.push(`${path}.budget.${key} must be a number`);
		}
		if (typeof step.id === "string") {
			if (ids.has(step.id)) problems.push(`${path}.id "${step.id}" is used twice`);
			ids.add(step.id);
		}
		if (step.status === "active") active++;
	});
	if (active > 1) problems.push(`${active} steps are active; at most one may be`);
	return problems;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

export interface ReadResult {
	plan: Plan;
	/** True when the file differs from what this store last wrote or accepted. */
	changedExternally: boolean;
	/** Hash of the text this plan was parsed from; pass it to accept(). */
	hash: string;
	/** The plan as this store last wrote or accepted it, when known; for showing what changed. */
	previous: Plan | undefined;
}

/**
 * Plan files under <root>/<harnessDir>/plans/, and the ACTIVE pointer. Remembers the hash of each
 * plan as it last wrote or accepted it, so a change made by someone else is detected.
 */
export class PlanStore {
	readonly dir: string;
	private readonly known = new Map<string, { hash: string; plan: Plan | undefined }>();
	/** The last plan read() parsed, so accept() can remember it along with its hash. */
	private readonly parsed = new Map<string, { hash: string; plan: Plan }>();

	constructor(root: string, harnessDir = "harness") {
		this.dir = join(root, harnessDir, "plans");
	}

	pathOf(planId: string): string {
		return join(this.dir, `${planId}.json`);
	}

	exists(planId: string): boolean {
		return PLAN_ID.test(planId) && existsSync(this.pathOf(planId));
	}

	/** Read and validate a plan. The first read of a plan in this store is accepted as known. */
	read(planId: string): ReadResult {
		if (!this.exists(planId)) throw new PlanError(`no plan ${planId} in ${this.dir}`);
		const text = readFileSync(this.pathOf(planId), "utf8");
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (e) {
			throw new PlanError(`plan ${planId} is not valid JSON: ${(e as Error).message}`);
		}
		const problems = planProblems(value);
		if (problems.length > 0) throw new PlanError(`plan ${planId} is not valid:\n  - ${problems.join("\n  - ")}`);
		const hash = hashOf(text);
		const plan = value as Plan;
		const known = this.known.get(planId);
		if (known === undefined) this.known.set(planId, { hash, plan });
		this.parsed.set(planId, { hash, plan });
		const changedExternally = known !== undefined && known.hash !== hash;
		return { plan, changedExternally, hash, previous: changedExternally ? known.plan : undefined };
	}

	/** Treat the plan text that read() returned, identified by its hash, as known. */
	accept(planId: string, hash: string): void {
		const parsed = this.parsed.get(planId);
		this.known.set(planId, { hash, plan: parsed?.hash === hash ? parsed.plan : undefined });
	}

	/** Write a plan atomically and remember its hash. */
	write(plan: Plan): void {
		mkdirSync(this.dir, { recursive: true });
		const text = JSON.stringify(plan, null, 2) + "\n";
		const path = this.pathOf(plan.plan_id);
		writeFileSync(`${path}.tmp`, text);
		renameSync(`${path}.tmp`, path);
		this.known.set(plan.plan_id, { hash: hashOf(text), plan });
	}

	/** Write a new plan; refuses to overwrite an existing one. */
	create(plan: Plan): void {
		if (this.exists(plan.plan_id)) throw new PlanError(`plan ${plan.plan_id} already exists; use /plan-use ${plan.plan_id}`);
		this.write(plan);
	}

	activeId(): string | null {
		const path = join(this.dir, "ACTIVE");
		if (!existsSync(path)) return null;
		const id = readFileSync(path, "utf8").trim();
		return id === "" ? null : id;
	}

	setActive(planId: string): void {
		if (!this.exists(planId)) throw new PlanError(`no plan ${planId} in ${this.dir}`);
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, "ACTIVE"), `${planId}\n`);
	}
}
