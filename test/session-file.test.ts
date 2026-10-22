/**
 * Session surgery tests. Every fixture is a real-shaped JSONL file on disk:
 * the module under test reads and rewrites files, so the tests read and rewrite
 * files too rather than mocking fs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdit, applyRemove, readSessionDocument, rebuildContent } from "../src/session-file.ts";

function makeSession(lines: unknown[]): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "psm-test-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return { dir, path };
}

function header(): unknown {
	return { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" };
}

function message(id: string, parentId: string | null, role: string, content: unknown[]): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content, timestamp: 1, ...(role === "toolResult" ? { toolCallId: "t1", toolName: "bash" } : {}) },
	};
}

function rawLines(path: string): string[] {
	return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

// ---------------------------------------------------------------------------
// rebuildContent
// ---------------------------------------------------------------------------

test("rebuildContent replaces a single text block and keeps thinking/toolCall", () => {
	const content = [
		{ type: "thinking", thinking: "hmm" },
		{ type: "text", text: "old" },
		{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
	];
	assert.deepEqual(rebuildContent(content, "new"), [
		{ type: "thinking", thinking: "hmm" },
		{ type: "text", text: "new" },
		{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
	]);
});

test("rebuildContent keeps images and collapses multiple text blocks at the first position", () => {
	const content = [
		{ type: "text", text: "a" },
		{ type: "image", data: "base64", mimeType: "image/png" },
		{ type: "text", text: "b" },
	];
	assert.deepEqual(rebuildContent(content, "joined"), [
		{ type: "text", text: "joined" },
		{ type: "image", data: "base64", mimeType: "image/png" },
	]);
});

// ---------------------------------------------------------------------------
// readSessionDocument
// ---------------------------------------------------------------------------

test("readSessionDocument keeps raw lines and skips malformed ones", () => {
	const { dir, path } = makeSession([header(), message("a", null, "user", [{ type: "text", text: "hi" }])]);
	writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`);

	const document = readSessionDocument(path);
	assert.equal(document.header.id, "s1");
	assert.equal(document.entries.length, 1);
	assert.equal(document.lines.length, 3);
	rmSync(dir, { recursive: true, force: true });
});

test("readSessionDocument rejects a foreign or old session file", () => {
	const { dir, path } = makeSession([{ ...(header() as object), version: 2 }, message("a", null, "user", [])]);
	assert.throws(() => readSessionDocument(path), /session 版本/);
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// applyEdit
// ---------------------------------------------------------------------------

test("applyEdit rewrites only the target line and logs the original", () => {
	const { dir, path } = makeSession([
		header(),
		message("a", null, "user", [{ type: "text", text: "old question" }]),
		message("b", "a", "assistant", [{ type: "text", text: "answer" }]),
	]);
	const before = rawLines(path);

	applyEdit({ path, entryId: "a", newText: "new question" });

	const after = rawLines(path);
	assert.equal(after.length, before.length);
	assert.equal(after[0], before[0]);
	assert.equal(after[2], before[2], "untouched lines stay byte-identical");
	assert.match(after[1] ?? "", /new question/);
	assert.doesNotMatch(after[1] ?? "", /old question/);

	const log = readFileSync(`${path}.psm-log`, "utf8").trim().split("\n");
	assert.equal(log.length, 1);
	const record = JSON.parse(log[0] ?? "{}") as { op: string; entryId: string; originalLine: string };
	assert.equal(record.op, "edit");
	assert.equal(record.entryId, "a");
	assert.match(record.originalLine, /old question/);
	assert.equal(existsSync(`${path}.psm-tmp`), false);

	rmSync(dir, { recursive: true, force: true });
});

test("applyEdit refuses non-message entries", () => {
	const { dir, path } = makeSession([
		header(),
		{ type: "custom", id: "c1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "x" },
	]);
	assert.throws(() => applyEdit({ path, entryId: "c1", newText: "x" }), /不是消息/);
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// applyRemove
// ---------------------------------------------------------------------------

function turnSession(): { dir: string; path: string } {
	return makeSession([
		header(),
		message("u1", null, "user", [{ type: "text", text: "first" }]),
		message("a1", "u1", "assistant", [{ type: "text", text: "reply one" }]),
		{ type: "usage", id: "us1", parentId: "a1", timestamp: "2026-01-01T00:00:00.000Z", kind: "warm" },
		message("u2", "us1", "user", [{ type: "text", text: "second" }]),
		message("a2", "u2", "assistant", [{ type: "text", text: "reply two" }]),
	]);
}

test("applyRemove drops the turn, keeps bookkeeping, reparents the next user", () => {
	const { dir, path } = turnSession();

	const outcome = applyRemove({ path, userId: "u1", branchIds: ["u1", "a1", "us1", "u2", "a2"] });
	assert.equal(outcome.removed, 2);
	assert.equal(outcome.reparented, 1);

	const document = readSessionDocument(path);
	const ids = document.entries.map(({ entry }) => entry.id);
	assert.deepEqual(ids, ["us1", "u2", "a2"]);

	const usage = document.entries.find(({ entry }) => entry.id === "us1")?.entry;
	assert.equal(usage?.parentId, null);
	const second = document.entries.find(({ entry }) => entry.id === "u2")?.entry;
	assert.equal(second?.parentId, "us1");

	const log = readFileSync(`${path}.psm-log`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(
		log.map((record: { op: string }) => record.op),
		["delete", "reparent"],
	);
	const deleted = log[0] as { removedLines: string[] };
	assert.equal(deleted.removedLines.length, 2);

	rmSync(dir, { recursive: true, force: true });
});

test("applyRemove refuses a turn that anchors a compaction summary", () => {
	const { dir, path } = makeSession([
		header(),
		message("u1", null, "user", [{ type: "text", text: "first" }]),
		message("a1", "u1", "assistant", [{ type: "text", text: "reply" }]),
		{
			type: "compaction",
			id: "cp1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: "s",
			firstKeptEntryId: "u1",
			tokensBefore: 10,
		},
		message("u2", "cp1", "user", [{ type: "text", text: "second" }]),
	]);

	assert.throws(
		() => applyRemove({ path, userId: "u1", branchIds: ["u1", "a1", "cp1", "u2"] }),
		/压缩摘要/,
	);
	rmSync(dir, { recursive: true, force: true });
});

test("applyRemove refuses when another branch hangs off the removed range", () => {
	const { dir, path } = makeSession([
		header(),
		message("u1", null, "user", [{ type: "text", text: "first" }]),
		message("a1", "u1", "assistant", [{ type: "text", text: "reply" }]),
		message("a1b", "a1", "assistant", [{ type: "text", text: "other branch" }]),
		message("u2", "a1", "user", [{ type: "text", text: "second" }]),
	]);

	assert.throws(
		() => applyRemove({ path, userId: "u1", branchIds: ["u1", "a1", "u2"] }),
		/另一条分支/,
	);
	rmSync(dir, { recursive: true, force: true });
});

test("applyRemove keeps unrelated turns byte-identical", () => {
	const { dir, path } = turnSession();
	const before = rawLines(path);

	applyRemove({ path, userId: "u2", branchIds: ["u1", "a1", "us1", "u2", "a2"] });

	const after = rawLines(path);
	assert.equal(after.length, 4);
	assert.equal(after[0], before[0]);
	assert.equal(after[1], before[1]);
	assert.equal(after[2], before[2]);
	assert.equal(after[3], before[3]);

	rmSync(dir, { recursive: true, force: true });
});
