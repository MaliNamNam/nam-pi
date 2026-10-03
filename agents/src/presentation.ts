import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, CustomMessageComponent,
	type MarkdownTransformer, type MessageRenderer, type EntryRenderer, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import type { ChildToolDefinition } from "./view.ts";

export interface ChildPresentation {
	markdownTheme?: MarkdownTheme;
	markdownTransformers?: readonly MarkdownTransformer[];
	outputPad?: number;
	hideThinking?: boolean;
	hiddenThinkingLabel?: string;
	toolDefinitions: ReadonlyMap<string, ChildToolDefinition>;
	messageRenderers: ReadonlyMap<string, MessageRenderer>;
	entryRenderers: ReadonlyMap<string, EntryRenderer>;
	createEntry?: (entry: any, renderer: EntryRenderer) => Component & { setExpanded(expanded: boolean): void };
}

/**
 * Read-only Pi 1.0 presentation adapter. Its public component constructors accept
 * these options, but ExtensionAPI has no getters for the root renderer registry.
 * Copy the live root components' rendering options (never messages/session state).
 * Do not traverse overlays: another child's preview must not become our source.
 */
export function captureChildPresentation(tui: TUI, tools: ReadonlyMap<string, ChildToolDefinition>, settings?: ReturnType<ExtensionAPI["getSettings"]>): ChildPresentation {
	const profile: ChildPresentation = { outputPad: settings?.outputPad, toolDefinitions: new Map(tools), messageRenderers: new Map(), entryRenderers: new Map() };
	const definitions = profile.toolDefinitions as Map<string, ChildToolDefinition>;
	const renderers = profile.messageRenderers as Map<string, MessageRenderer>;
	const entryRenderers = profile.entryRenderers as Map<string, EntryRenderer>;
	const root = tui as unknown as { layoutRoot?: unknown; children?: unknown[] };
	const pending: unknown[] = root.layoutRoot ? [root.layoutRoot] : [...(root.children ?? [])];
	const seen = new Set<unknown>();
	for (let index = 0; index < pending.length && index < 4096; index++) {
		const value = pending[index];
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		const node = value as Record<string, any>;
		if (value instanceof AssistantMessageComponent || value instanceof UserMessageComponent) {
			if (node.markdownTheme) profile.markdownTheme = node.markdownTheme;
			if (Array.isArray(node.markdownTransformers)) profile.markdownTransformers = node.markdownTransformers.filter((item: unknown): item is MarkdownTransformer => typeof item === "function");
			if (typeof node.outputPad === "number") profile.outputPad = node.outputPad;
			if (value instanceof AssistantMessageComponent) {
				if (typeof node.hideThinkingBlock === "boolean") profile.hideThinking = node.hideThinkingBlock;
				if (typeof node.hiddenThinkingLabel === "string") profile.hiddenThinkingLabel = node.hiddenThinkingLabel;
			}
		}
		if (value instanceof ToolExecutionComponent && typeof node.toolName === "string" && node.toolDefinition) definitions.set(node.toolName, node.toolDefinition);
		if (value instanceof CustomMessageComponent && typeof node.message?.customType === "string" && typeof node.customRenderer === "function") renderers.set(node.message.customType, node.customRenderer);
		// CustomEntryComponent is not re-exported by Pi. Retain the live native
		// constructor rather than importing an unsupported internal package path.
		if (node.constructor?.name === "CustomEntryComponent" && typeof node.entry?.customType === "string" && typeof node.renderer === "function") {
			entryRenderers.set(node.entry.customType, node.renderer);
			const NativeEntry = node.constructor as new (entry: any, renderer: EntryRenderer) => Component & { setExpanded(expanded: boolean): void };
			profile.createEntry = (entry, renderer) => new NativeEntry(entry, renderer);
		}
		if (Array.isArray(node.children)) pending.push(...node.children);
		if (node.child && typeof node.child.render === "function") pending.push(node.child);
	}
	return profile;
}
