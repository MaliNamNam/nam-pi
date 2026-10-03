import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PiEvent, Usage } from "./runner.ts";
import type { OutputRange } from "./subagent-result.ts";

const MAX_ITEMS = 40;

function preview(value: string, limit = 160): string {
	const compact = stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

/** Stable, low-frequency progress events; never update the TUI on every token. */
export function describeChildEvent(event: PiEvent): string | undefined {
	if (event.type === "tool_execution_start") {
		const name = typeof event.toolName === "string" ? preview(event.toolName, 64) : "tool";
		const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
		const target = args.command ?? args.path ?? args.pattern ?? args.query ?? "";
		return `→ ${name}${typeof target === "string" && target ? ` ${preview(target, 100)}` : ""}`;
	}
	if (event.type === "tool_execution_end" && event.isError === true) {
		return `✗ ${typeof event.toolName === "string" ? preview(event.toolName, 64) : "tool"} failed`;
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const content = event.message.content;
		const text = Array.isArray(content)
			? content.filter((part): part is { type: "text"; text: string } =>
				part?.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ")
			: typeof content === "string" ? content : "";
		if (text.trim()) return `✦ ${preview(text)}`;
		if (event.message.stopReason === "error") return "✗ Model request failed";
	}
	return undefined;
}

export class ChildProgress {
	readonly items: string[] = [];
	private readonly transcript: string[] = [];
	private streamingText = "";
	model?: string;

	timeline(): string[] {
		const lines = [...this.transcript, ...(this.streamingText ? this.streamingText.split("\n") : [])];
		return lines.length ? lines.slice(-300) : ["(Waiting for child output…)"];
	}

	add(event: PiEvent): boolean {
		if (event.type === "message_update" && event.assistantMessageEvent && typeof event.assistantMessageEvent === "object") {
			const delta = event.assistantMessageEvent as { type?: string; delta?: string };
			if (delta.type === "text_delta" && typeof delta.delta === "string") {
				this.streamingText = (this.streamingText + stripTerminalSequences(delta.delta)).slice(-32_768);
			}
		}
		if (event.type === "message_end" && event.message) {
			if (event.message.role === "assistant") this.streamingText = "";
			const content = event.message.content;
			const text = typeof content === "string" ? content : Array.isArray(content)
				? content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
					.map((part) => part.text).join("\n") : "";
			if (text && ["user", "assistant", "toolResult"].includes(event.message.role ?? "")) {
				this.transcript.push(`${event.message.role === "toolResult" ? "TOOL" : event.message.role?.toUpperCase()}:`,
					...stripTerminalSequences(text).split("\n"));
				if (this.transcript.length > 300) this.transcript.splice(0, this.transcript.length - 300);
			}
		}
		if (event.type === "tool_execution_start") {
			const tool = describeChildEvent(event);
			if (tool) this.transcript.push(tool);
			if (this.transcript.length > 300) this.transcript.shift();
		}
		if (event.type === "message_end" && event.message?.role === "assistant" && event.message.model) {
			this.model = event.message.model;
		}
		const line = describeChildEvent(event);
		if (!line) return false;
		if (this.items.length >= MAX_ITEMS) this.items.shift();
		this.items.push(line);
		return true;
	}
}

export interface SubagentToolDetails {
	sessionID: string;
	status: "running" | "completed" | "error";
	agent: string;
	description: string;
	progress?: string[];
	output?: string;
	/** Large results reference their full model-facing content instead of duplicating it. */
	outputRange?: OutputRange;
	usage?: Usage;
	model?: string;
	background?: boolean;
}
