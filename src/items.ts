/**
 * Shared helpers for building picker rows out of session entries.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { preview, roleLabel, textOf } from "./messages.ts";
import type { PickerItem } from "./ui.ts";

export function isUserMessage(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/** Tool name for toolResult entries, if present. */
function toolNameOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	const name = (entry.message as { toolName?: unknown }).toolName;
	return typeof name === "string" ? name : undefined;
}

/** One row per message that has text to edit (assistant tool-call-only turns are skipped). */
export function editableItems(branch: SessionEntry[]): PickerItem[] {
	const items: PickerItem[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

		const text = textOf(entry);
		if (!text || text.trim() === "") continue;

		const toolName = toolNameOf(entry);
		const head = toolName ? `${roleLabel(role)} ${toolName}` : roleLabel(role);
		items.push({ id: entry.id, label: `${head}  ${preview(text)}` });
	}
	return items;
}

/** One row per user message, with the size of the turn it starts. */
export function turnItems(branch: SessionEntry[]): PickerItem[] {
	const items: PickerItem[] = [];
	let current: PickerItem | undefined;
	let currentCount = 0;

	const flush = () => {
		if (!current) return;
		const suffix = currentCount > 1 ? `  ·  ${currentCount} 条` : "";
		items.push({ id: current.id, label: current.label + suffix });
	};

	for (const entry of branch) {
		if (isUserMessage(entry)) {
			flush();
			const text = textOf(entry) ?? "";
			current = { id: entry.id, label: `你  ${preview(text)}` };
			currentCount = 1;
			continue;
		}
		currentCount += 1;
	}
	flush();

	return items;
}
