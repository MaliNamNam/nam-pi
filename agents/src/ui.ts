import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { ComposerChild, OpenCodeComposerEditor } from "./composer.ts";
import type { ChildSessionPage } from "./view.ts";

/** Synchronous, session-scoped presentation bridge. No commands or session switches. */
export const AGENTS_UI_CONNECT = "pi-agents:ui:connect";
export const AGENTS_UI_REQUEST = "pi-agents:ui:request";
export const AGENTS_UI_STATE = "pi-agents:ui:state";
export const AGENTS_UI_DECORATE = "pi-agents:ui:decorate-child";

export interface AgentsUIController {
	sessionID: string;
	createComposer(tui: TUI, theme: EditorTheme, keys: KeybindingsManager): OpenCodeComposerEditor;
	viewChild(id: string): void;
	openSubagentModels(): void;
}
export interface AgentsUIState {
	sessionID: string;
	children: ComposerChild[];
}
export interface ChildPageDecoration {
	sessionID: string;
	childID: string;
	title: string;
	cwd: string;
	branch?: string;
	tui: TUI;
	theme: Theme;
	page: ChildSessionPage;
	/** A UI extension may wrap the page, but must forward input and disposal. */
	component: Component;
	viewChild(id: string): void;
}
