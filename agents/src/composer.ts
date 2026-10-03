import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ShellStatus } from "./shells.ts";

/** Normal OpenCode TUI: routes/session/composer/{index,subagents-tab,shell-tab}.tsx. */
export interface ComposerChild {
	id: string;
	agent: string;
	title: string;
	status: "running" | "completed" | "error" | "cancelled";
	background?: boolean;
	current?: boolean;
	prefix?: string;
}
export interface ComposerShell { id: string; command: string; output: string[]; status?: ShellStatus; exitCode?: number; error?: string; }
export interface ComposerActions {
	viewChild(id: string): void;
	interruptChild(id: string): Promise<string>;
	viewShell(id: string): void;
	interruptShell?(id: string): Promise<string>;
	backgroundWork?(): void;
	onClose?(): void;
}

function plain(value: string): string {
	return stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

/** The composer replaces the editor while open; it is not a popup or another terminal. */
export class OpenCodeComposerEditor extends CustomEditor {
	private panel: "subagents" | "shell" | undefined;
	private activeOnly = true;
	private selected = 0;
	private offset = 0;
	private children: ComposerChild[] = [];
	private shells: ComposerShell[] = [];
	private panelRows = 5;
	private footerRow = -1;
	private footerStart = 0;
	private rowStart = 3;
	private hintRow = 9;
	private notice = "";
	private stopping = false;
	private readonly palette: () => Theme;
	private readonly actions: ComposerActions;

	constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, palette: () => Theme, actions: ComposerActions) {
		super(tui, theme, keys, { embedWorkingStatus: true });
		this.palette = palette;
		this.actions = actions;
	}

	get isPanelOpen(): boolean { return this.panel !== undefined; }
	get hasJobs(): boolean { return this.children.length > 0 || this.shells.length > 0; }

	update(children: ComposerChild[], shells: ComposerShell[]): void {
		if (JSON.stringify(this.children) === JSON.stringify(children) && JSON.stringify(this.shells) === JSON.stringify(shells)) return;
		const selectedID = this.entries[this.selected]?.id;
		this.children = children;
		this.shells = shells;
		const selected = this.entries.findIndex((entry) => entry.id === selectedID);
		this.selected = selected >= 0 ? selected : Math.min(this.selected, Math.max(0, this.entries.length - 1));
		this.reveal();
		this.tui.requestRender();
	}

	open(): void {
		this.panel = "subagents";
		this.activeOnly = true;
		this.selected = Math.max(0, this.entries.findIndex((entry) => (entry as ComposerChild).current));
		this.offset = 0;
		this.notice = "";
		this.tui.requestRender();
	}

	close(): void {
		if (this.actions.onClose) return this.actions.onClose();
		this.panel = undefined;
		this.notice = "";
		this.tui.requestRender();
	}

	private get entries(): Array<ComposerChild | ComposerShell> {
		return this.panel === "shell" ? this.shells : this.children.filter((child) =>
			this.activeOnly ? child.status === "running" : child.status !== "running");
	}

	private reveal(): void {
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + this.panelRows) this.offset = this.selected - this.panelRows + 1;
	}

	private selectEntry(): void {
		const entry = this.entries[this.selected];
		if (!entry) return;
		if (this.panel === "shell") this.actions.viewShell(entry.id);
		else this.actions.viewChild(entry.id);
	}

	private interrupt(): void {
		if (this.stopping) return;
		const entry = this.entries[this.selected];
		if (!entry) return;
		const interrupt = this.panel === "shell" ? this.actions.interruptShell :
			(entry as ComposerChild).status === "running" ? this.actions.interruptChild : undefined;
		if (!interrupt) return;
		this.stopping = true;
		void interrupt(entry.id).then((message) => { this.notice = plain(message); })
			.catch(() => { this.notice = "Unable to interrupt this job"; })
			.finally(() => { this.stopping = false; this.tui.requestRender(); });
	}

	handleInput(data: string): void {
		if (!this.panel) {
			if (matchesKey(data, "ctrl+b") && this.actions.backgroundWork &&
				this.children.some((child) => child.status === "running" && !child.background)) {
				this.actions.backgroundWork();
				return;
			}
			if (matchesKey(data, "down") && !this.getText().trim() && !this.isShowingAutocomplete() && (this.children.length || this.shells.length)) {
				this.open();
				return;
			}
			super.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.close();
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.panel = this.panel === "subagents" ? "shell" : "subagents";
			this.selected = this.panel === "subagents" ? Math.max(0, this.entries.findIndex((entry) => (entry as ComposerChild).current)) : 0;
			this.offset = 0;
			this.notice = "";
		} else if (matchesKey(data, "ctrl+a") && this.panel === "subagents") {
			this.activeOnly = !this.activeOnly;
			this.selected = 0;
			this.offset = 0;
		} else if (matchesKey(data, "up")) {
			if (this.selected === 0) return this.close(); // OpenCode closes on first Up
			this.selected--;
		} else if (matchesKey(data, "down")) {
			if (this.entries.length) this.selected = (this.selected + 1) % this.entries.length;
		} else if (matchesKey(data, "return")) return this.selectEntry();
		else if (matchesKey(data, "ctrl+d")) return this.interrupt();
		else if (matchesKey(data, "pageUp")) this.selected = Math.max(0, this.selected - this.panelRows);
		else if (matchesKey(data, "pageDown")) this.selected = Math.min(Math.max(0, this.entries.length - 1), this.selected + this.panelRows);
		else return; // Don't type into the preserved parent draft while in the panel.
		this.reveal();
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.panel) {
			if (event.type === "click" && event.y === this.footerRow && event.x >= this.footerStart) {
				this.open();
				return { handled: true, focus: true };
			}
			return super.handleMouse(event);
		}
		if (event.type === "wheel") {
			this.selected = Math.max(0, Math.min(this.entries.length - 1, this.selected + Math.sign(event.wheelDelta ?? 0)));
			this.reveal();
			return { handled: true, focus: true };
		}
		if (event.type !== "click" && event.type !== "move") return { handled: true };
		if (event.y >= this.rowStart && event.y < this.rowStart + this.panelRows) {
			const index = this.offset + event.y - this.rowStart;
			if (index < this.entries.length) {
				this.selected = index;
				if (event.type === "click") this.selectEntry();
			}
		} else if (event.type === "click" && event.y === (this.rowStart === 1 ? 0 : 1)) {
			if (event.x >= event.width - 6) this.close();
			else if (event.x >= 13 && event.x < 20) { this.panel = "shell"; this.selected = this.offset = 0; }
			else if (event.x < 13) { this.panel = "subagents"; this.selected = this.offset = 0; }
		} else if (event.type === "click" && event.y === this.hintRow) {
			if (this.panel === "shell" && this.actions.interruptShell && event.x >= 16 && event.x < 29) this.interrupt();
			else if (this.panel === "shell" && event.x < 16) this.selectEntry();
			else if (this.panel === "subagents") {
				const active = (this.entries[this.selected] as ComposerChild | undefined)?.status === "running";
				if (active && event.x < 23) this.interrupt();
				else { this.activeOnly = !this.activeOnly; this.selected = this.offset = 0; }
			}
		}
		return { handled: true, focus: true, render: true };
	}

	render(width: number, maxHeight?: number): string[] {
		if (!this.panel) {
			const lines = super.render(width);
			if (this.actions.backgroundWork && this.children.some((child) => child.status === "running" && !child.background)) {
				lines.unshift(this.palette().fg("muted", truncateToWidth("Press ctrl+b to move running work to the background", width)));
			}
			const count = this.children.filter((child) => child.status === "running").length;
			if (count) {
				const hint = `↓ ${count} subagent${count === 1 ? "" : "s"}`;
				this.footerRow = lines.length;
				this.footerStart = Math.max(0, width - visibleWidth(hint));
				lines.push(" ".repeat(this.footerStart) + this.palette().fg("muted", truncateToWidth(hint, width)));
			} else this.footerRow = -1;
			return lines;
		}
		const th = this.palette();
		const inner = Math.max(0, width - 4); // left border + outer pad 1/2, exactly as Composer.tsx
		if (width < 6) return [truncateToWidth("esc", width)];
		const available = maxHeight ?? this.tui.terminal.rows ?? 24;
		const compact = maxHeight !== undefined && available < 7;
		this.rowStart = compact ? 1 : 3;
		this.panelRows = compact ? Math.max(0, Math.min(5, available - 2)) : Math.max(1, Math.min(5, available - 7));
		this.reveal();
		const frame = (value: string, selected = false, current = false): string => {
			const content = truncateToWidth(value, inner, "…", true);
			return th.fg("border", "┃") + th.bg("customMessageBg", " ") + (selected
				? th.bg("selectedBg", th.fg("text", th.bold(content)))
				: current ? th.bg("userMessageBg", th.fg("accent", content)) : th.bg("customMessageBg", content)) + th.bg("customMessageBg", "  ");
		};
		const heading = ` ${this.panel === "subagents" ? th.bold(th.fg("text", "Subagents")) : th.fg("muted", "Subagents")}  ` +
			`${this.panel === "shell" ? th.bold(th.fg("text", "Shell")) : th.fg("muted", "Shell")}`;
		const header = heading + " ".repeat(Math.max(0, inner - visibleWidth(heading) - 3)) + th.fg("muted", "esc");
		const lines = compact ? [frame(header)] : [frame(""), frame(header), frame("")];
		const entries = this.entries;
		for (let row = 0; row < this.panelRows; row++) {
			const index = this.offset + row;
			const entry = entries[index];
			if (!entry) {
				const empty = row === 0 && !entries.length ? (this.panel === "shell" ? " No shell commands" : ` No ${this.activeOnly ? "active" : "inactive"} subagents`) : "";
				lines.push(frame(th.fg("muted", empty)));
				continue;
			}
			const child = entry as ComposerChild;
			const title = this.panel === "shell" ? plain((entry as ComposerShell).command) : `${child.prefix ?? ""}${plain(child.agent)}: ${plain(child.title)}`;
			const status = this.panel === "subagents" && child.status === "running" ? "Running" : "";
			const label = truncateToWidth(` ${title}`, Math.max(0, inner - (status ? status.length + 2 : 1)));
			const content = label + " ".repeat(Math.max(1, inner - visibleWidth(label) - status.length - 1)) + status + " ";
			lines.push(frame(content, index === this.selected, this.panel === "subagents" && child.current));
		}
		if (!compact) lines.push(frame(""));
		const child = entries[this.selected] as ComposerChild | undefined;
		const hints = this.panel === "subagents"
			? `${child?.status === "running" ? th.bold("interrupt") + th.fg("muted", " ctrl+d  ") : ""}` +
				`${th.bold(`show ${this.activeOnly ? "inactive" : "active"}`)}${th.fg("muted", " ctrl+a  ")}`
			: entries.length ? th.bold("output") + th.fg("muted", " enter  ") + (this.actions.interruptShell ? th.bold("kill") + th.fg("muted", " ctrl+d  ") : "") : "";
		this.hintRow = lines.length;
		if (!compact || lines.length < available) lines.push(frame(` ${this.notice || hints + th.bold("tabs") + th.fg("muted", " ←/→")}`));
		if (!compact) lines.push(frame(""));
		return lines;
	}
}
