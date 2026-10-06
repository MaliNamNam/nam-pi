import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function withoutPiIdentity(text: string): string {
	return text.replace(/^You are an expert coding assistant operating inside pi, a coding agent harness\.[ \t]*/, "");
}

export default function (pi: ExtensionAPI) {
	// Project each request, including resumed sessions, without replacing Pi's
	// structured prompt or changing tool declarations and conversation history.
	pi.on("context_with_system", (event) => ({
		messages: event.messages.map((message) => {
			if (message.role !== "system") return message;
			const preamble = message.sections?.preamble;
			return {
				...message,
				...(typeof message.content === "string" ? { content: withoutPiIdentity(message.content) } : {}),
				...(typeof preamble === "string" ? { sections: { ...message.sections, preamble: withoutPiIdentity(preamble) } } : {}),
			};
		}),
	}));
}
