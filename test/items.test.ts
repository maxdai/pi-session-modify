/**
 * Picker row construction: what the user sees must match what the command acts on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { editableItems, turnItems } from "../src/items.ts";

function message(id: string, parentId: string | null, role: string, content: unknown[]): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content, timestamp: 1 },
	} as unknown as SessionEntry;
}

function bookkeeping(id: string, parentId: string | null, type: string): SessionEntry {
	return { type, id, parentId, timestamp: "2026-01-01T00:00:00.000Z" } as unknown as SessionEntry;
}

test("editableItems skips tool-call-only assistant turns", () => {
	const branch = [
		message("u1", null, "user", [{ type: "text", text: "问题" }]),
		message("a1", "u1", "assistant", [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }]),
		message("a2", "a1", "assistant", [{ type: "text", text: "回答" }]),
	];
	assert.deepEqual(
		editableItems(branch).map((item) => item.id),
		["u1", "a2"],
	);
});

test("turnItems counts only entries that /psm-remove would drop", () => {
	const branch = [
		message("u1", null, "user", [{ type: "text", text: "第一轮" }]),
		message("a1", "u1", "assistant", [{ type: "text", text: "回答一" }]),
		bookkeeping("bk1", "a1", "thinking_level_change"),
		message("u2", "bk1", "user", [{ type: "text", text: "第二轮" }]),
		message("a2", "u2", "assistant", [{ type: "text", text: "回答二" }]),
		bookkeeping("bk2", "a2", "usage"),
	];

	const items = turnItems(branch);
	assert.equal(items.length, 2);
	assert.match(items[0]?.label ?? "", /第一轮/);
	assert.match(items[0]?.label ?? "", /2 条/);
	assert.match(items[1]?.label ?? "", /第二轮/);
	assert.match(items[1]?.label ?? "", /2 条/);
});
