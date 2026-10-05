import { ModelSelectorComponent, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { clampPiVariant, supportedPiVariants } from "./models.ts";

type PickerModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];
export interface SubagentModelEntry {
	id: string;
	name: string;
	reference: string;
	model?: PickerModel;
	thinkingLevel: string;
	overridden: boolean;
}
interface PickerOptions {
	keys: KeybindingsManager;
	registry: ExtensionContext["modelRegistry"];
	scopedModels?: ExtensionContext["scopedModels"];
	entries(): SubagentModelEntry[];
	save(id: string, model: string | null): Promise<string | undefined>;
	close(): void;
}

/** One popup owns both the agent list and Pi's native searchable model picker. */
export class SubagentModelPicker implements Component, Focusable {
	private selected = 0;
	private offset = 0;
	private picker?: ModelSelectorComponent;
	private _focused = false;
	private disposed = false;
	private busy = false;
	private notice = "";
	private rows: { y: number; index: number }[] = [];
	private pickerMouseRows: number[] = [];
	private pickerHeight = 0;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; if (this.picker) this.picker.focused = value; }
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly options: PickerOptions;
	constructor(tui: TUI, theme: Theme, options: PickerOptions) { this.tui = tui; this.theme = theme; this.options = options; }

	private entry(): SubagentModelEntry | undefined { return this.options.entries()[this.selected]; }
	private back(): void { this.picker?.dispose(); this.picker = undefined; this.pickerMouseRows = []; this.tui.requestRender(); }
	private save(entry: SubagentModelEntry, reference: string | null): void {
		this.busy = true; this.notice = "Updating assignment and running children…";
		this.tui.requestRender();
		void this.options.save(entry.id, reference).then((notice) => { this.notice = notice ?? "Assignment saved for this session."; })
			.catch((error) => { this.notice = error instanceof Error ? error.message : String(error); })
			.finally(() => { this.busy = false; if (!this.disposed) this.tui.requestRender(); });
	}
	private cycleThinking(): void {
		const entry = this.entry();
		if (!entry?.model) { this.notice = "Select an available model first."; this.tui.requestRender(); return; }
		const levels = supportedPiVariants(entry.model);
		if (levels.length < 2) return;
		const level = levels[(levels.indexOf(entry.thinkingLevel) + 1) % levels.length];
		this.save(entry, `${entry.model.provider}/${entry.model.id}#${level}`);
	}
	private chooseModel(): void {
		const entry = this.entry();
		if (!entry) return;
		const registry = this.options.registry;
		// ModelSelector needs only this runtime surface; the extension owns no
		// second runtime, authentication store, or global-default save callback.
		const runtime = {
			getAvailableSnapshot: () => registry.getAvailable(),
			getModel: (provider: string, id: string) => registry.find(provider, id),
			getError: () => registry.getError(),
			refresh: (options: Parameters<typeof registry.refresh>[0]) => registry.refresh(options),
		} as unknown as ConstructorParameters<typeof ModelSelectorComponent>[2];
		this.picker = new ModelSelectorComponent(this.tui, entry.model, runtime, this.options.scopedModels ?? [], (model) => {
			const level = clampPiVariant(model, this.entry()?.thinkingLevel ?? entry.thinkingLevel);
			this.back();
			this.save(entry, `${model.provider}/${model.id}#${level}`);
		}, () => this.back());
		this.picker.focused = this.focused;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.options.keys.matches(data, "tui.select.cancel")) {
			if (this.picker) this.back(); else this.options.close();
			return;
		}
		if (this.busy) return;
		if (this.options.keys.matches(data, "app.thinking.cycle")) return this.cycleThinking();
		if (this.picker) { this.picker.handleInput(data); return; }
		const entries = this.options.entries();
		if (this.options.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (this.options.keys.matches(data, "tui.select.down")) this.selected = Math.min(Math.max(0, entries.length - 1), this.selected + 1);
		else if (this.options.keys.matches(data, "tui.select.confirm") || this.options.keys.matches(data, "app.model.select")) return this.chooseModel();
		else if (matchesKey(data, "ctrl+r")) { const entry = this.entry(); if (entry) this.save(entry, null); return; }
		else return;
		this.tui.requestRender();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || this.busy) return undefined;
		if (this.picker) {
			const y = this.pickerMouseRows[event.y];
			if (y === undefined || y < 0) return undefined;
			const result = this.picker.handleMouse({ ...event, y, height: this.pickerHeight });
			if (!result) return undefined;
			// Keep keyboard focus on this wrapper so thinking keys remain role-scoped.
			const { focusTarget: _nativeFocus, ...response } = result;
			return response;
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const row = this.rows.find((row) => row.y === event.y);
		if (!row) return undefined;
		this.selected = row.index;
		this.chooseModel();
		return { handled: true, focus: true };
	}
	render(width: number): string[] {
		const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ");
		const entry = this.entry();
		const confirm = this.options.keys.getKeys("tui.select.confirm")[0] ?? "unbound";
		const thinking = this.options.keys.getKeys("app.thinking.cycle")[0] ?? "unbound";
		const cancel = this.options.keys.getKeys("tui.select.cancel")[0] ?? "unbound";
		if (this.picker) {
			const native = this.picker.render(width);
			this.pickerHeight = native.length;
			let rows = native.map((_, index) => index);
			const budget = Math.max(1, Math.floor(this.tui.terminal.rows * 0.9) - 3);
			let content = native;
			if (native.length > budget) {
				// Preserve the public search component and native borders; scroll only
				// the wrapped results around Pi's visible selection arrow.
				const search = this.picker.children.indexOf(this.picker.getSearchInput());
				const head = this.picker.children.slice(0, search + 2).reduce((height, child) => height + child.render(width).length, 0);
				const body = native.slice(head, -1);
				const count = Math.max(1, budget - head - 3);
				const selected = body.findIndex((line) => stripTerminalSequences(line).startsWith("→ "));
				const start = Math.max(0, Math.min(selected - Math.floor(count / 2), body.length - count));
				const end = Math.min(body.length, start + count);
				content = [...native.slice(0, head), this.theme.fg("dim", start ? "↑ more" : ""), ...body.slice(start, end),
					this.theme.fg("dim", end < body.length ? "↓ more" : ""), native[native.length - 1]];
				rows = [...rows.slice(0, head), -1, ...rows.slice(head + start, head + end), -1, native.length - 1];
			}
			this.pickerMouseRows = [-1, ...rows, -1, -1];
			return [truncateToWidth(this.theme.fg("accent", `${clean(entry?.name ?? "Subagent")} · ${entry?.thinkingLevel ?? "off"}`), width),
				...content, truncateToWidth(this.theme.fg("dim", `${confirm} select · ${thinking} thinking`), width),
				truncateToWidth(this.theme.fg("dim", `${cancel} back`), width)];
		}
		if (width < 4) return [truncateToWidth("Subagent models", width)];
		const frame = (text: string) => this.theme.fg("border", "│") + truncateToWidth(` ${text}`, width - 2, "…", true) + this.theme.fg("border", "│");
		const lines = [this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`), frame(this.theme.fg("accent", "Subagent models · this session")), frame("")];
		const entries = this.options.entries();
		const count = Math.max(1, Math.floor((Math.floor(this.tui.terminal.rows * 0.9) - 8) / 2));
		this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, entries.length - count)));
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + count) this.offset = this.selected - count + 1;
		this.rows = [];
		for (const [offset, item] of entries.slice(this.offset, this.offset + count).entries()) {
			const index = this.offset + offset, selected = index === this.selected;
			this.rows.push({ y: lines.length, index }, { y: lines.length + 1, index });
			lines.push(frame(this.theme.fg(selected ? "accent" : "text", `${selected ? "›" : " "} ${clean(item.name)}${item.overridden ? " · session" : " · default"}`)));
			lines.push(frame(this.theme.fg("muted", `  ${clean(item.reference)} · ${item.thinkingLevel}`)));
		}
		if (!entries.length) lines.push(frame("No available subagents"));
		lines.push(frame(""), frame(this.theme.fg("dim", `${confirm} model · ${thinking} thinking`)),
			frame(this.theme.fg("dim", `ctrl+r default · ${cancel} close`)));
		if (this.notice) lines.push(frame(this.theme.fg("muted", clean(this.notice))));
		lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
		return lines;
	}
	invalidate(): void { this.picker?.invalidate(); }
	dispose(): void { this.disposed = true; this.picker?.dispose(); this.picker = undefined; }
}
