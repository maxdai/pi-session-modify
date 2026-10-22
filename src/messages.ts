/**
 * Structural helpers over session message content.
 *
 * A session message entry is one entry with one id; its content is a block array
 * (text / thinking / toolCall / image). Measured across real sessions: assistant
 * messages carry at most one text block, user and toolResult carry exactly one.
 * So "edit the message" means "replace its text blocks, keep everything else".
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface TextLikeBlock {
	type: "text";
	text: string;
}

function isTextLikeBlock(block: unknown): block is TextLikeBlock {
	if (typeof block !== "object" || block === null) return false;
	const candidate = block as { type?: unknown; text?: unknown };
	return candidate.type === "text" && typeof candidate.text === "string";
}

/** All text in a message, blocks joined with a blank line. Undefined for other entries. */
export function textOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;

	const message = entry.message;
	const role = message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return undefined;

	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;

	const parts: string[] = [];
	for (const block of content) {
		if (isTextLikeBlock(block)) parts.push(block.text);
	}
	return parts.join("\n\n");
}

/** Single-line preview: collapse whitespace, cut to `max` characters. */
export function preview(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1)}…`;
}

export function roleLabel(role: string): string {
	switch (role) {
		case "user":
			return "你";
		case "assistant":
			return "助手";
		case "toolResult":
			return "工具结果";
		default:
			return role;
	}
}
