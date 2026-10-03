import { JsonlReader } from "./jsonl.ts";
import {
	AssistantMessageComponent, CustomMessageComponent, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
	createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition, createReadToolDefinition,
	createWriteToolDefinition, getSelectListTheme, ToolExecutionComponent, UserMessageComponent, type KeybindingsManager, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { describeChildEvent } from "./progress.ts";
import type { PiEvent } from "./runner.ts";
import { OpenCodeComposerEditor, type ComposerChild, type ComposerShell } from "./composer.ts";
import { shellOutput, shellStatusLabel } from "./shells.ts";
import type { ChildPresentation } from "./presentation.ts";

const MAX_VIEW_LINES = 300;
const MAX_STREAM_TEXT = 32_768;

function cleanDisplayLine(line: string): string {
	return stripTerminalSequences(line)
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: "text"; text: string } =>
		part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text).join("\n");
}

function messageLines(message: Record<string, unknown>): string[] {
	const role = message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return [];
	const text = textParts(message.content);
	const calls = role === "assistant" && Array.isArray(message.content)
		? message.content.filter((part): part is { type: "toolCall"; name: string } =>
			part && typeof part === "object" && part.type === "toolCall" && typeof part.name === "string")
			.map((part) => `→ ${part.name}`)
		: [];
	const label = role === "toolResult" ? "TOOL" : role.toUpperCase();
	const body = text ? text.split(/\r?\n/).map((line, index) => index ? `  ${line}` : `${label}: ${line}`) : [];
	return [...body, ...calls];
}

/** Plain-text fallback for clients that do not run Pi's TUI. */
export async function readChildTimeline(file: string, kind: "session" | "events"): Promise<string[]> {
	const transcript = await readChildTranscript(file, kind);
	const lines = transcript.entries.flatMap((entry) => {
		if (entry.type === "message") return messageLines(entry.message);
		if (entry.type === "entry") return [];
		const summary = describeChildEvent({ type: "tool_execution_start", toolName: entry.name, args: entry.args });
		return [summary ?? `→ ${entry.name}`, ...(entry.result ? messageLines({ role: "toolResult", content: entry.result.content }) : []),
			...(entry.partial === false ? [`${entry.result?.isError ? "✗" : "✓"} ${entry.name} finished`] : [])];
	});
	return lines.length ? lines.slice(-MAX_VIEW_LINES).map(cleanDisplayLine) : [transcript.notice ?? "(No child messages yet.)"];
}

type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type ChildTranscriptEntry =
	| { type: "message"; message: Record<string, unknown>; streaming?: boolean }
	| { type: "entry"; entry: Record<string, unknown> }
	| { type: "tool"; id: string; name: string; args: unknown; started?: boolean; result?: ToolResult; partial?: boolean };
export interface ChildTranscript {
	entries: ChildTranscriptEntry[];
	notice?: string;
	model?: { provider: string; id: string; contextWindow?: number };
	thinking?: string;
	/** Whole-log facts, independent of the bounded display tail. Never parent-session data. */
	stats?: { spend: number; tokens: number | null; cacheHitRate: number | null; files: string[]; tools?: string[] };
	/** Cheap change detection without serializing the complete transcript every second. */
	revision?: number;
}

let transcriptRevision = 0;

function cleanRecord(value: unknown): unknown {
	if (typeof value === "string") return cleanDisplayLine(value);
	if (Array.isArray(value)) return value.map(cleanRecord);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanRecord(item)]));
	return value;
}

/** Incremental state survives long reasoning turns and logs larger than 512 KiB. */
class TranscriptReader {
	readonly reader: JsonlReader;
	private entries: ChildTranscriptEntry[] = [];
	private tools = new Map<string, Extract<ChildTranscriptEntry, { type: "tool" }>>();
	private streaming?: Record<string, unknown>;
	private argumentText = new Map<number, string>();
	private model?: ChildTranscript["model"];
	private thinking?: string;
	private spend = 0;
	private tokens: number | null = null;
	private cacheHitRate: number | null = null;
	private files = new Set<string>();
	private declaredTools?: string[];
	private revision = ++transcriptRevision;
	private notice?: string;
	private snapshot?: ChildTranscript;
	private readonly kind: "session" | "events";
	constructor(file: string, kind: "session" | "events") { this.reader = new JsonlReader(file); this.kind = kind; }
	private reset = (): void => {
		this.entries = []; this.tools.clear(); this.streaming = undefined; this.argumentText.clear();
		this.model = undefined; this.thinking = undefined; this.spend = 0; this.tokens = null; this.cacheHitRate = null;
		this.files.clear(); this.declaredTools = undefined; this.revision = ++transcriptRevision;
	};
	private tool(id: unknown, name: unknown, args?: unknown): Extract<ChildTranscriptEntry, { type: "tool" }> {
		const key = typeof id === "string" ? id : `tool-${this.revision}`;
		let entry = this.tools.get(key);
		if (!entry) {
			entry = { type: "tool", id: key, name: typeof name === "string" ? name : "tool", args: args ?? {} };
			this.tools.set(key, entry); this.entries.push(entry);
		} else {
			if (args !== undefined) entry.args = args;
			if (typeof name === "string") entry.name = name;
		}
		return entry;
	}
	private addMessage(message: Record<string, unknown>): void {
		if (message.role === "assistant" || message.role === "toolResult") {
			const usage = message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;
			const cost = usage?.cost?.total; if (typeof cost === "number" && Number.isFinite(cost)) this.spend += cost;
			if (message.role === "assistant" && usage) {
				const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
				const prompt = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
				if (prompt + count(usage.output) > 0) { this.tokens = prompt + count(usage.output); this.cacheHitRate = prompt ? count(usage.cacheRead) / prompt * 100 : null; }
			}
		}
		if (message.role === "toolResult") {
			const entry = this.tool(message.toolCallId, message.toolName);
			entry.result = { ...message, content: Array.isArray(message.content) ? message.content : [], isError: message.isError === true };
			entry.partial = false;
			if (!entry.result.isError && ["edit", "write"].includes(entry.name)) {
				const args = entry.args as { path?: unknown } | undefined; if (typeof args?.path === "string") this.files.add(args.path);
			}
		} else if (message.role === "user" || message.role === "assistant" || message.role === "custom" && message.display === true) {
			this.entries.push({ type: "message", message });
			if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) {
				if (part?.type === "toolCall" && typeof part.name === "string") this.tool(part.id, part.name, part.arguments);
			}
		}
	}
	private delta(event: Record<string, unknown>): void {
		const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;
		if (!Number.isInteger(index) || index < 0 || index > 256) return;
		this.streaming ??= { role: "assistant", content: [] };
		const content: Record<string, unknown>[] = Array.isArray(this.streaming.content) ? [...this.streaming.content] : [];
		let part = content[index] ?? {};
		if (event.type === "text_start") part = { type: "text", text: "" };
		else if (event.type === "thinking_start") part = { type: "thinking", thinking: "" };
		else if (event.type === "text_delta" || event.type === "thinking_delta") {
			const thinking = event.type === "thinking_delta", key = thinking ? "thinking" : "text";
			part = { ...part, type: thinking ? "thinking" : "text", [key]: (String(part[key] ?? "") + String(event.delta ?? "")).slice(-MAX_STREAM_TEXT) };
		} else if (event.type === "text_end" || event.type === "thinking_end") {
			const thinking = event.type === "thinking_end";
			part = { ...part, type: thinking ? "thinking" : "text", [thinking ? "thinking" : "text"]: String(event.content ?? "").slice(-MAX_STREAM_TEXT) };
		} else if (event.type === "toolcall_start") {
			this.argumentText.set(index, "");
			part = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
			this.tool(event.id, event.toolName);
		} else if (event.type === "toolcall_delta") {
			const raw = (this.argumentText.get(index) ?? "") + String(event.delta ?? "");
			this.argumentText.set(index, raw.slice(-MAX_STREAM_TEXT));
			try {
				const args: unknown = JSON.parse(raw);
				part = { ...part, arguments: args }; this.tool(part.id, part.name, args);
			} catch { /* incomplete arguments remain streaming until toolcall_end */ }
		} else if (event.type === "toolcall_end" && event.toolCall && typeof event.toolCall === "object") {
			part = event.toolCall as Record<string, unknown>;
			this.argumentText.delete(index); this.tool(part.id, part.name, part.arguments);
		} else return;
		content[index] = part;
		this.streaming = { ...this.streaming, content: Array.from(content, (block) => block ?? { type: "text", text: "" }) };
	}
	private consume = (raw: Record<string, unknown>): void => {
		const record = cleanRecord(raw) as Record<string, unknown>;
		if (record.type === "model_change" && typeof record.provider === "string" && typeof record.modelId === "string") this.model = { provider: record.provider, id: record.modelId };
		if (record.type === "thinking_level_change" && typeof record.thinkingLevel === "string") this.thinking = record.thinkingLevel;
		const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : undefined;
		if (message?.role === "assistant") {
			if (typeof message.provider === "string" && typeof message.model === "string") this.model = { provider: message.provider, id: message.model,
				...(this.model?.provider === message.provider && this.model.id === message.model && this.model.contextWindow ? { contextWindow: this.model.contextWindow } : {}) };
			if (typeof message.thinkingLevel === "string") this.thinking = message.thinkingLevel;
		}
		if (message?.role === "system" && Array.isArray(message.tools)) this.declaredTools = message.tools.flatMap((tool: any) => typeof tool?.name === "string" ? [tool.name] : []);
		const appended = record.type === "entry_appended" ? record.entry as Record<string, any> | undefined : undefined;
		const accounting = appended ?? record;
		if (["usage", "compaction", "branch_summary"].includes(String(accounting.type))) {
			const cost = accounting.usage?.cost?.total; if (typeof cost === "number" && Number.isFinite(cost)) this.spend += cost;
		}
		if (appended?.customType === "subagent-ui-state" || record.type === "custom" && record.customType === "subagent-ui-state") {
			const state = (record.type === "custom" ? record.data : (record.entry as any)?.data) as { tools?: unknown; model?: ChildTranscript["model"] } | undefined;
			if (Array.isArray(state?.tools)) this.declaredTools = state.tools.filter((name): name is string => typeof name === "string");
			if (typeof state?.model?.provider === "string" && typeof state.model.id === "string") this.model = state.model;
		}
		if ((appended?.type === "custom" || record.type === "custom") && !String(accounting.customType).startsWith("subagent-")) this.entries.push({ type: "entry", entry: accounting });
		if (this.kind === "session") {
			if (record.type === "message" && message) this.addMessage(message);
		} else if (record.type === "message_end" && message) {
			if (message.role === "assistant") { this.streaming = undefined; this.argumentText.clear(); }
			this.addMessage(message);
		} else if ((record.type === "message_start" || record.type === "message_update") && message?.role === "assistant") this.streaming = message;
		else if (record.type === "message_update" && record.assistantMessageEvent && typeof record.assistantMessageEvent === "object") this.delta(record.assistantMessageEvent as Record<string, unknown>);
		else if (record.type === "tool_execution_start") this.tool(record.toolCallId, record.toolName, record.args).started = true;
		else if (record.type === "tool_execution_update" || record.type === "tool_execution_end") {
			const entry = this.tool(record.toolCallId, record.toolName);
			const result = (record.partialResult ?? record.result) as Record<string, unknown> | undefined;
			if (result && Array.isArray(result.content)) entry.result = { ...result, content: result.content, isError: record.isError === true || result.isError === true };
			entry.partial = record.type === "tool_execution_update";
		}
		while (this.entries.length > MAX_VIEW_LINES) {
			const removed = this.entries.shift()!;
			if (removed.type === "tool") this.tools.delete(removed.id);
		}
		this.revision = ++transcriptRevision;
	};
	async read(): Promise<ChildTranscript> {
		const result = await this.reader.read(this.consume, this.reset);
		const notice = result.missing ? "(Waiting for child output…)" : result.notice;
		if (notice !== this.notice) { this.notice = notice; this.revision = ++transcriptRevision; }
		if (this.snapshot?.revision === this.revision) return this.snapshot;
		const entries = [...this.entries];
		if (this.streaming) entries.push({ type: "message", message: { ...this.streaming }, streaming: true });
		return this.snapshot = { entries: entries.slice(-MAX_VIEW_LINES), notice, model: this.model, thinking: this.thinking,
			stats: { spend: this.spend, tokens: this.tokens, cacheHitRate: this.cacheHitRate, files: [...this.files], tools: this.declaredTools }, revision: this.revision };
	}
}
const transcriptReaders = new Map<string, TranscriptReader>();

/** Keep native Pi message/tool state, while parsing only newly appended bytes. */
export async function readChildTranscript(file: string, kind: "session" | "events"): Promise<ChildTranscript> {
	const key = `${kind}:${file}`;
	let reader = transcriptReaders.get(key);
	if (!reader) reader = new TranscriptReader(file, kind);
	transcriptReaders.delete(key); transcriptReaders.set(key, reader);
	if (transcriptReaders.size > 4) transcriptReaders.delete(transcriptReaders.keys().next().value!);
	return reader.read();
}

export type ChildToolDefinition = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

export interface ChildViewOptions {
	/** Normal OpenCode child navigation is a page, not a floating inspector box. */
	fullPage?: boolean;
	title?: string;
	cwd?: string;
	/** Root registrations, including custom UI renderers, override native fallbacks. */
	toolDefinitions?: ReadonlyMap<string, ChildToolDefinition>;
	/** Root's real Markdown transforms/theme/padding and already-registered renderers. */
	presentation?: ChildPresentation;
	/** Viewport rows when a child page reserves space for its composer. */
	rows?: () => number;
	/** Arrow keys belong to the child composer; use page keys for the transcript. */
	pageScrollOnly?: boolean;
	load?: () => Promise<string[] | ChildTranscript>;
	onNext?: () => void;
	/** Delegations inside a child transcript navigate within the same family viewer. */
	viewChild?: (id: string) => void;
	onInterrupt?: () => Promise<string>;
	status?: () => string;
}

/** Live child inspector: follows the tail until the user scrolls, within Pi's TUI. */
export class ChildTranscriptView implements Component {
	private offset = 0;
	private followTail = true;
	private content: string[] = [];
	private components: Component[] = [];
	private componentRows: { component: Component; start: number; height: number; childID?: string }[] = [];
	private componentCache = new Map<string, { value: string; component: Component }>();
	private expanded = false;
	private hideThinking = false;
	private cachedWidth = -1;
	private disposed = false;
	private refreshing = false;
	private interrupting = false;
	private note = "";
	private timer?: ReturnType<typeof setInterval>;
	private get height(): number {
		const rows = this.options.rows?.() ?? this.tui.terminal?.rows ?? 25;
		return this.options.fullPage ? Math.max(1, rows - 5) : Math.max(1, Math.min(17, rows - 6));
	}
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly id: string;
	private data: string[] | ChildTranscript;
	private readonly done: () => void;
	private readonly options: ChildViewOptions;
	constructor(tui: TUI, theme: Theme, id: string, data: string[] | ChildTranscript, done: () => void, options: ChildViewOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.id = id;
		this.data = Array.isArray(data) ? data.map(cleanDisplayLine) : data;
		this.done = done;
		this.options = options;
		this.hideThinking = options.presentation?.hideThinking ?? false;
		if (options.load) {
			this.timer = setInterval(() => void this.refresh(), 1000);
			this.timer.unref();
		}
	}

	async refresh(): Promise<void> {
		if (this.disposed || this.refreshing || !this.options.load) return;
		this.refreshing = true;
		try {
			const loaded = await this.options.load();
			const next = Array.isArray(loaded) ? loaded.map(cleanDisplayLine) : loaded;
			const unchanged = !Array.isArray(next) && !Array.isArray(this.data) && next.revision !== undefined && this.data.revision !== undefined
				? next.revision === this.data.revision : JSON.stringify(next) === JSON.stringify(this.data);
			if (this.disposed || unchanged) return;
			this.data = next;
			this.components = [];
			this.invalidate();
			this.tui.requestRender();
		} catch {
			// A session switch or a partial child write is retried on the next tick.
		} finally { this.refreshing = false; }
	}

	private buildComponents(): void {
		if (Array.isArray(this.data)) return;
		const cwd = this.options.cwd ?? process.cwd();
		const definitions = new Map<string, ChildToolDefinition>([
			createReadToolDefinition, createBashToolDefinition, createPowerShellToolDefinition, createEditToolDefinition,
			createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
		].map((create) => { const definition = create(cwd); return [definition.name, definition] as const; }));
		for (const [name, definition] of this.options.toolDefinitions ?? []) definitions.set(name, definition);
		for (const [name, definition] of this.options.presentation?.toolDefinitions ?? []) definitions.set(name, definition);
		const profile = this.options.presentation;
		const cache = new Map<string, { value: string; component: Component }>();
		this.components = this.data.entries.map((entry, index) => {
			const key = entry.type === "tool" ? `tool:${entry.id}` : `message:${index}`;
			const value = JSON.stringify(entry);
			const previous = this.componentCache.get(key);
			let component = previous?.component;
			if (previous?.value !== value) {
				if (entry.type === "tool") {
					if (!(component instanceof ToolExecutionComponent)) {
						const execution = new ToolExecutionComponent(entry.name, entry.id, entry.args, { showImages: false }, definitions.get(entry.name), this.tui, cwd);
						execution.setExpanded(this.expanded);
						component = execution;
					}
					const execution = component as ToolExecutionComponent;
					execution.updateArgs(entry.args);
					if (entry.started) execution.markExecutionStarted();
					execution.setArgsComplete();
					if (entry.result) execution.updateResult(entry.result, entry.partial);
				} else if (entry.type === "entry") {
					const renderer = profile?.entryRenderers.get(String(entry.entry.customType));
					const nativeEntry = renderer && profile?.createEntry?.(entry.entry, renderer);
					if (nativeEntry) nativeEntry.setExpanded(this.expanded);
					component = nativeEntry || new Text("", 0, 0);
				} else if (entry.message.role === "user") {
					component = new UserMessageComponent(textParts(entry.message.content), profile?.markdownTheme, profile?.outputPad, profile?.markdownTransformers);
				} else if (entry.message.role === "custom") {
					component = new CustomMessageComponent(entry.message as any, profile?.messageRenderers.get(String(entry.message.customType)), profile?.markdownTheme, profile?.outputPad);
					(component as CustomMessageComponent).setExpanded(this.expanded);
				} else {
					if (!(component instanceof AssistantMessageComponent)) component = new AssistantMessageComponent(undefined, this.hideThinking,
						profile?.markdownTheme, profile?.hiddenThinkingLabel, profile?.outputPad, profile?.markdownTransformers);
					const message = { ...entry.message, content: Array.isArray(entry.message.content) ? entry.message.content : [{ type: "text", text: textParts(entry.message.content) }] };
					(component as AssistantMessageComponent).updateContent(message as NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>, entry.streaming);
				}
			}
			cache.set(key, { value, component: component! });
			return component!;
		});
		for (const [key, previous] of this.componentCache) {
			if (cache.get(key)?.component !== previous.component) this.releaseComponent(previous.component);
		}
		this.componentCache = cache;
	}

	private scroll(delta: number): void {
		const end = Math.max(0, this.content.length - this.height);
		this.offset = Math.max(0, Math.min(end, this.offset + delta));
		this.followTail = this.offset === end;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.dispose(); return this.done(); }
		if (matchesKey(data, "tab") && this.options.onNext) { this.dispose(); return this.options.onNext(); }
		if (matchesKey(data, "ctrl+o")) {
			this.expanded = !this.expanded;
			for (const component of this.components) if (typeof (component as any).setExpanded === "function") (component as any).setExpanded(this.expanded);
			this.invalidate();
			return this.tui.requestRender();
		}
		if (matchesKey(data, "ctrl+t")) {
			this.hideThinking = !this.hideThinking;
			for (const component of this.components) if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(this.hideThinking);
			this.invalidate();
			return this.tui.requestRender();
		}
		if (matchesKey(data, "ctrl+d") && this.options.onInterrupt) {
			if (!this.interrupting) {
				this.interrupting = true;
				void this.options.onInterrupt().then((message) => { this.note = cleanDisplayLine(message); })
					.catch(() => { this.note = "Unable to interrupt this child"; })
					.finally(() => { this.interrupting = false; if (!this.disposed) this.tui.requestRender(); });
			}
			return;
		}
		if (matchesKey(data, "up")) return this.scroll(-1);
		if (matchesKey(data, "down")) return this.scroll(1);
		if (matchesKey(data, "pageUp")) return this.scroll(-this.height);
		if (matchesKey(data, "pageDown")) return this.scroll(this.height);
		if (matchesKey(data, "home")) { this.followTail = false; this.offset = 0; }
		else if (matchesKey(data, "end")) this.followTail = true;
		else return;
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") { this.scroll(event.wheelDelta ?? 0); return { handled: true }; }
		const row = event.y - (this.options.fullPage ? 3 : 2);
		if (row < 0 || row >= this.height) return undefined;
		const target = this.componentRows.find((item) => row + this.offset >= item.start && row + this.offset < item.start + item.height);
		if (event.type === "click" && event.button === "left" && target?.childID && this.options.viewChild) {
			this.options.viewChild(target.childID);
			return { handled: true };
		}
		const result = target?.component.handleMouse?.({ ...event, x: event.x - 1, y: row + this.offset - target.start, width: Math.max(1, event.width - 2), height: target.height });
		if (result?.handled) { this.invalidate(); this.tui.requestRender(); }
		return result;
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("Esc close", Math.max(0, width))];
		const inner = width - 2;
		if (this.cachedWidth !== width) {
			this.componentRows = [];
			if (Array.isArray(this.data)) {
				for (const { component } of this.componentCache.values()) this.releaseComponent(component);
				this.componentCache.clear();
				this.components = [];
				this.content = this.data.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, inner - 1)));
			} else {
				if (!this.components.length) this.buildComponents();
				this.content = [];
				for (const [index, component] of this.components.entries()) {
					const lines = component.render(Math.max(1, inner));
					const entry = this.data.entries[index];
					const child = entry?.type === "tool" && entry.name === "subagent" ? entry.result?.details as { sessionID?: unknown } | undefined : undefined;
					this.componentRows.push({ component, start: this.content.length, height: lines.length,
						childID: typeof child?.sessionID === "string" ? child.sessionID : undefined });
					this.content.push(...lines);
				}
				if (!this.content.length) this.content = [this.data.notice ?? "(No child messages yet.)"];
			}
			this.cachedWidth = width;
		}
		const end = Math.max(0, this.content.length - this.height);
		this.offset = this.followTail ? end : Math.min(this.offset, end);
		const border = (value: string) => this.theme.fg("border", value);
		const row = (value: string) => border("│") + truncateToWidth(value, inner, "…", true) + border("│");
		const status = this.options.status?.();
		const title = truncateToWidth(` ${this.options.title ?? `Subagent ${this.id}`} `, inner);
		const header = border("╭") + this.theme.fg("accent", title) + border("─".repeat(Math.max(0, inner - visibleWidth(title))) + "╮");
		const hints = ` ↑↓ PgUp/PgDn · Home/End · Esc back${this.options.onNext ? " · Tab next" : ""}${this.options.onInterrupt ? " · Ctrl+D stop" : ""}`;
		const body = this.content.slice(this.offset, this.offset + this.height);
		if (this.options.fullPage) {
			const pageRow = (value: string) => truncateToWidth(` ${value}`, width, "…", true);
			const title = this.options.title ?? `Subagent ${this.id}`;
			const rows = [pageRow(this.theme.fg("accent", title)), pageRow(this.theme.fg("dim", status ?? this.id)), pageRow("")];
			for (const line of body) rows.push(pageRow(line));
			for (let index = body.length; index < this.height; index++) rows.push(pageRow(""));
			rows.push(pageRow(""), pageRow(this.note || this.theme.fg("muted", "esc parent" +
				(this.options.onNext ? " · tab next" : "") + (this.options.onInterrupt ? " · ctrl+d interrupt" : "") +
				(this.options.pageScrollOnly ? " · pgup/pgdn scroll" : " · ↑↓ scroll") + (!Array.isArray(this.data) ? " · ctrl+o tools · ctrl+t thinking" : ""))));
			return rows;
		}
		const output = [header, row(this.note || (status ? ` ${status} · ${hints.trim()}` : hints))];
		for (const line of body) output.push(row(` ${line}`));
		for (let i = body.length; i < this.height; i++) output.push(row(""));
		output.push(border("╰" + "─".repeat(inner) + "╯"));
		return output;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		for (const { component } of this.componentCache.values()) component.invalidate();
	}
	private releaseComponent(component: Component): void {
		// Pi's shell renderers stop their elapsed-time interval on a final result.
		// Finalize only this discarded preview, never the child's actual execution.
		if (component instanceof ToolExecutionComponent) component.updateResult({ content: [], isError: false }, false);
	}
	dispose(): void {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const { component } of this.componentCache.values()) this.releaseComponent(component);
		this.componentCache.clear();
	}
}

interface ChildPageOptions extends ChildViewOptions {
	children: ComposerChild[];
	viewChild(id: string): void;
	interruptChild(id: string): Promise<string>;
	shells?(): ComposerShell[];
	interruptShell?(id: string): Promise<string>;
	backgroundWork?(): void;
	pendingForms?(): number;
}

function childShells(data: string[] | ChildTranscript): ComposerShell[] {
	if (Array.isArray(data)) return [];
	return data.entries.flatMap((entry) => {
		if (entry.type !== "tool" || !["bash", "powershell"].includes(entry.name)) return [];
		const args = entry.args && typeof entry.args === "object" ? entry.args as Record<string, unknown> : {};
		return [{ id: entry.id, command: typeof args.command === "string" ? args.command : entry.name,
			status: entry.started === true && entry.partial !== false ? "running" as const : "exited" as const, output: textParts(entry.result?.content).split("\n") }];
	});
}

/** V2 child pages replace the chat editor with an always-open job composer. */
export class ChildSessionPage implements Component {
	private readonly transcript: ChildTranscriptView;
	private readonly composer: OpenCodeComposerEditor;
	private transcriptRows = 6;
	private footerStart = 0;
	private clippedRows = 0;
	private children: ComposerChild[];
	private data: string[] | ChildTranscript;
	private composerFrame?: (lines: string[], width: number) => string[];
	private shells: ReturnType<typeof childShells>;
	private shellPreview?: { view: ChildTranscriptView; hide: () => void };
	private disposed = false;
	private readonly tui: TUI;
	private readonly options: ChildPageOptions;

	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, id: string,
		data: string[] | ChildTranscript, done: () => void, options: ChildPageOptions) {
		this.tui = tui;
		this.options = options;
		this.data = data;
		this.children = options.children;
		this.shells = options.shells?.() ?? childShells(data);
		this.composer = new OpenCodeComposerEditor(tui, { borderColor: (text) => theme.fg("border", text), selectList: getSelectListTheme() }, keys, () => theme, {
			viewChild: options.viewChild, interruptChild: options.interruptChild,
			interruptShell: options.interruptShell,
			viewShell: (shellID) => {
				const shell = this.shells.find((entry) => entry.id === shellID);
				if (!shell || this.shellPreview) return;
				const current = () => this.shells.find((entry) => entry.id === shellID) ?? shell;
				const view = new ChildTranscriptView(tui, theme, "Shell", [shell.command, "", ...shellOutput(shell)], () => this.closeShellPreview(), {
					title: "Shell output", load: async () => [shell.command, "", ...shellOutput(current())],
					status: () => shellStatusLabel({ ...current(), status: current().status ?? "running" }),
				});
				const handle = tui.showOverlay(view, { width: "90%", maxHeight: "80%", anchor: "center" });
				this.shellPreview = { view, hide: () => handle.hide() };
			},
			onClose: () => { this.dispose(); done(); },
		});
		this.updateComposer();
		this.composer.open();
		this.transcript = new ChildTranscriptView(tui, theme, id, data, done, {
			...options, fullPage: true, rows: () => this.transcriptRows, pageScrollOnly: true, onNext: undefined, onInterrupt: undefined,
			load: options.load ? async () => {
				const next = await options.load!();
				if (!this.disposed) { this.data = next; this.shells = options.shells?.() ?? childShells(next); this.updateComposer(); }
				return next;
			} : undefined,
		});
	}

	/** Presentation-only snapshot; never opens or writes the child session. */
	get snapshot(): { data: string[] | ChildTranscript; children: ComposerChild[] } {
		return { data: this.data, children: this.children };
	}
	setComposerFrame(frame: (lines: string[], width: number) => string[]): void {
		this.composerFrame = frame;
		this.tui.requestRender();
	}

	updateChildren(children: ComposerChild[]): void {
		if (this.disposed) return;
		this.children = children;
		this.updateComposer();
	}
	private updateComposer(): void { this.composer.update(this.children, this.shells.filter((shell) => shell.status === "running")); }

	async refresh(): Promise<void> { await this.transcript.refresh(); }

	handleInput(data: string): void {
		if (this.disposed) return;
		if ((["pageUp", "pageDown", "home", "end", "ctrl+o", "ctrl+t"] as const).some((key) => matchesKey(data, key))) return this.transcript.handleInput(data);
		if (matchesKey(data, "ctrl+b") && this.children.some((child) => child.status === "running" && !child.background)) return this.options.backgroundWork?.();
		this.composer.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return event.y < this.footerStart ? this.transcript.handleMouse({ ...event, y: event.y + this.clippedRows }) :
			this.composer.handleMouse({ ...event, y: event.y - this.footerStart - (this.composerFrame ? 1 : 0), height: event.height - this.footerStart - (this.composerFrame ? 2 : 0) });
	}

	render(width: number): string[] {
		const rows = this.options.rows?.() ?? this.tui.terminal.rows ?? 25;
		const rawFooter = this.composer.render(width, Math.max(1, rows - 6 - (this.composerFrame ? 2 : 0)));
		const footer = this.composerFrame ? this.composerFrame(rawFooter, width) : rawFooter;
		this.transcriptRows = Math.max(6, rows - footer.length);
		const transcript = this.transcript.render(width);
		const pending = this.options.pendingForms?.();
		if (pending) transcript[transcript.length - 1] = truncateToWidth(` ${pending} form(s) waiting at root · Esc returns to parent`, width, "…", true);
		this.clippedRows = Math.max(0, transcript.length + footer.length - rows);
		this.footerStart = Math.max(0, transcript.length - this.clippedRows);
		return [...transcript, ...footer].slice(-rows);
	}

	invalidate(): void { this.transcript.invalidate(); this.composer.invalidate(); }
	private closeShellPreview(): void {
		this.shellPreview?.view.dispose();
		this.shellPreview?.hide();
		this.shellPreview = undefined;
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.closeShellPreview();
		this.transcript.dispose();
	}
}
