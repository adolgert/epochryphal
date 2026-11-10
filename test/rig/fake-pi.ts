// Hand-written stub of pi's ExtensionAPI for level 1 tests of the adapter.
//
// Each stubbed method is typed with pi's own type (ExtensionAPI["on"], ...), so the compiler
// reports when pi's API moves away from the stub. Calls to anything not stubbed throw, naming
// the missing member, so an adapter that starts using a new pi method fails loudly here.
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";

type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: unknown, ctx: unknown) => unknown;

/** Scripted answers for dialogs, used in order. Running out throws. */
export interface UiScript {
	select?: (string | undefined)[];
	confirm?: boolean[];
	input?: (string | undefined)[];
}

export interface ContextOptions {
	ui?: UiScript;
	/** Default true. */
	hasUI?: boolean;
	/** Default "tui" when hasUI, else "print". */
	mode?: "tui" | "rpc" | "json" | "print";
	cwd?: string;
	/** Default true. */
	idle?: boolean;
	/** Default "fake-session". */
	sessionId?: string;
}

export interface Notification {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

/** An object whose unlisted members throw when read, naming the member. */
function strict<T extends object>(label: string, members: Record<string, unknown>): T {
	return new Proxy(members, {
		get(target, prop) {
			if (typeof prop === "symbol" || prop === "then") return undefined;
			if (prop in target) return target[prop];
			throw new Error(`FakePi: ${label}.${prop} is not stubbed`);
		},
	}) as T;
}

export class FakePi {
	readonly tools = new Map<string, AnyTool>();
	readonly commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	readonly handlers = new Map<string, Handler[]>();
	readonly sentUserMessages: { content: unknown; options: unknown }[] = [];
	readonly sentMessages: { message: unknown; options: unknown }[] = [];
	readonly entries: { customType: string; data: unknown }[] = [];
	readonly notifications: Notification[] = [];
	/** Dialogs shown, in order, with their title and message (the second argument). */
	readonly dialogs: { kind: "select" | "confirm" | "input"; title: string; message: unknown }[] = [];
	/** Calls to ctx.abort and ctx.waitForIdle, in order. */
	readonly agentCalls: ("abort" | "waitForIdle")[] = [];
	/** Tools pi itself has, as getAllTools reports them. Tests may add others' tools here. */
	readonly builtinTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	/** The active tool names; registering a new tool activates it, as in pi. */
	activeTools: string[] = ["read", "bash", "edit", "write"];
	/** Arguments of each setActiveTools call, in order. */
	readonly setActiveToolsCalls: string[][] = [];
	private toolCallCount = 0;

	on: ExtensionAPI["on"] = ((event: string, handler: Handler) => {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			const i = list.indexOf(handler);
			if (i >= 0) list.splice(i, 1);
		};
	}) as ExtensionAPI["on"];

	registerTool: ExtensionAPI["registerTool"] = (tool) => {
		if (!this.tools.has(tool.name)) this.activeTools.push(tool.name);
		this.tools.set(tool.name, tool as AnyTool);
	};

	getAllTools: ExtensionAPI["getAllTools"] = () => {
		const info = (name: string, path: string) =>
			({ name, description: "", parameters: {}, exposure: "direct", sourceInfo: { path, source: path, scope: "temporary", origin: "top-level" } }) as unknown as ToolInfo;
		return [...this.builtinTools.map((n) => info(n, `builtin:${n}`)), ...[...this.tools.keys()].map((n) => info(n, "fake-extension"))];
	};

	getActiveTools: ExtensionAPI["getActiveTools"] = () => [...this.activeTools];

	setActiveTools: ExtensionAPI["setActiveTools"] = (names) => {
		this.setActiveToolsCalls.push([...names]);
		const known = new Set([...this.builtinTools, ...this.tools.keys()]);
		this.activeTools = names.filter((n) => known.has(n));
	};

	registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
		this.commands.set(name, options);
	};

	sendUserMessage: ExtensionAPI["sendUserMessage"] = (content, options) => {
		this.sentUserMessages.push({ content, options });
	};

	sendMessage: ExtensionAPI["sendMessage"] = (message, options) => {
		this.sentMessages.push({ message, options });
	};

	appendEntry: ExtensionAPI["appendEntry"] = (customType, data) => {
		this.entries.push({ customType, data });
	};

	/** Run an extension factory against this stub. */
	load(factory: (pi: ExtensionAPI) => void): this {
		const api = strict<ExtensionAPI>("pi", {
			on: this.on,
			registerTool: this.registerTool,
			registerCommand: this.registerCommand,
			sendUserMessage: this.sendUserMessage,
			sendMessage: this.sendMessage,
			appendEntry: this.appendEntry,
			getAllTools: this.getAllTools,
			getActiveTools: this.getActiveTools,
			setActiveTools: this.setActiveTools,
		});
		factory(api);
		return this;
	}

	toolNames(): string[] {
		return [...this.tools.keys()];
	}

	/** A stub context. Its UI answers dialogs from `options.ui` and records notifications. */
	context(options: ContextOptions = {}): ExtensionCommandContext {
		const hasUI = options.hasUI ?? true;
		let idle = options.idle ?? true;
		const answers = { select: [...(options.ui?.select ?? [])], confirm: [...(options.ui?.confirm ?? [])], input: [...(options.ui?.input ?? [])] };
		const take = <K extends keyof typeof answers>(kind: K, title: string, message?: unknown): (typeof answers)[K][number] => {
			this.dialogs.push({ kind, title, message });
			if (answers[kind].length === 0) throw new Error(`FakePi: no scripted answer for ui.${kind}("${title}")`);
			return answers[kind].shift() as (typeof answers)[K][number];
		};
		const ui = strict("ctx.ui", {
			select: async (title: string, options: unknown) => take("select", title, options),
			confirm: async (title: string, message: string) => take("confirm", title, message),
			input: async (title: string, placeholder?: string) => take("input", title, placeholder),
			notify: (message: string, type?: Notification["type"]) => {
				this.notifications.push({ message, type });
			},
			setStatus: () => {},
			setWidget: () => {},
		});
		return strict<ExtensionCommandContext>("ctx", {
			ui,
			hasUI,
			mode: options.mode ?? (hasUI ? "tui" : "print"),
			cwd: options.cwd ?? process.cwd(),
			model: undefined,
			signal: undefined,
			sessionManager: strict("ctx.sessionManager", {
				getSessionId: () => options.sessionId ?? "fake-session",
				getSessionFile: () => undefined,
			}),
			isIdle: () => idle,
			hasPendingMessages: () => false,
			abort: () => {
				this.agentCalls.push("abort");
			},
			waitForIdle: async () => {
				this.agentCalls.push("waitForIdle");
				idle = true; // As in pi: once waitForIdle returns, the agent is idle.
			},
		});
	}

	/** Call a registered tool's execute, as pi would. */
	async callTool(name: string, params: unknown, options: ContextOptions = {}): Promise<AgentToolResult<unknown>> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`FakePi: tool ${name} is not registered`);
		const id = `fake-call-${++this.toolCallCount}`;
		return tool.execute(id, params, undefined, undefined, this.context(options) as never);
	}

	/** Fire an event to its handlers in registration order; returns each handler's result. */
	async fire(event: string, payload: unknown, options: ContextOptions = {}): Promise<unknown[]> {
		const ctx = this.context(options);
		const results: unknown[] = [];
		for (const handler of [...(this.handlers.get(event) ?? [])]) results.push(await handler(payload, ctx));
		return results;
	}

	/** Run a registered command's handler. */
	async runCommand(name: string, args: string, options: ContextOptions = {}): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`FakePi: command ${name} is not registered`);
		await command.handler(args, this.context(options));
	}

	/** The concatenated text content of a tool result. */
	textOf(result: AgentToolResult<unknown>): string {
		return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	}
}
