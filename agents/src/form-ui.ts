import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { FormReply, FormRequest } from "./forms.ts";

const plain = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, " ");
const REJECT: FormReply = { reply: "reject", reason: "unavailable" };
const CANCELLED: FormReply = { reply: "reject", reason: "cancelled" };
const DECLINED: FormReply = { reply: "reject", reason: "declined" };

/** Native Pi dialogs replace the root editor, including in RPC; no child session switch. */
export async function showRootForm(ctx: ExtensionContext, request: FormRequest, signal: AbortSignal): Promise<FormReply> {
	if (signal.aborted) return CANCELLED;
	if (!ctx.hasUI) return REJECT;
	const form = request.payload;
	const scope = request.sessionID === ctx.sessionManager.getSessionId() ? "" : ` · ${plain(request.sessionID)}`;
	if (form.kind === "permission") {
		const options = ["Allow once", ...(form.checks.some((check) => check.action !== "question") ? ["Always for this Pi session"] : []), "Reject"];
		const selected = await ctx.ui.select(`Agent permission${scope}\n${plain(form.tool)}\n${plain(form.reason)}`, options, { signal });
		if (signal.aborted) return CANCELLED;
		if (selected === undefined || selected === "Reject") return DECLINED;
		if (!options.includes(selected)) return REJECT;
		return { reply: selected === options[0] ? "once" : "always" };
	}
	const answers: string[][] = [];
	for (const [index, question] of form.questions.entries()) {
		const values: string[] = [];
		const title = `Questions${scope} · ${index + 1}/${form.questions.length}\n${plain(question.header)}: ${plain(question.question)}`;
		while (!signal.aborted) {
			const options = question.options.map((option, optionIndex) => `${optionIndex + 1}. ${values.includes(option.label) ? "[x] " : question.multiple ? "[ ] " : ""}${plain(option.label)} — ${plain(option.description)}`);
			options.push("Type your own answer", ...(question.multiple ? ["Done selecting"] : []));
			const selected = await ctx.ui.select(title, options, { signal });
			if (signal.aborted) return CANCELLED;
			if (selected === undefined) return DECLINED;
			if (selected === "Done selecting") { if (values.length) break; continue; }
			let value: string | undefined;
			if (selected === "Type your own answer") {
				value = (await ctx.ui.input(title, "Your answer", { signal }))?.trim();
				if (signal.aborted) return CANCELLED;
				if (value === undefined) return DECLINED;
				if (!value) continue;
			} else {
				const at = options.indexOf(selected);
				value = question.options[at]?.label;
				if (!value) return REJECT;
			}
			const existing = values.indexOf(value);
			if (existing >= 0) values.splice(existing, 1); else values.push(value);
			if (!question.multiple) break;
		}
		if (signal.aborted) return CANCELLED;
		answers.push(values);
	}
	return { reply: "once", answers };
}
