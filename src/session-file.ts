/**
 * Session JSONL surgery: rewrite one message, or drop one turn.
 *
 * Everything here is synchronous on purpose. The extension runs in pi's own
 * process, so any await between "read the file" and "rename the temp file" would
 * let a background writer (cache warmer, another extension) slip in a line that
 * the rewrite would then drop.
 *
 * Only the lines that actually change are re-serialized; every other line is
 * written back byte-for-byte as it was read.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";

/** A session file with its raw lines and the parsed entries pinned to them. */
export interface SessionDocument {
	path: string;
	lines: string[];
	header: SessionHeader;
	entries: ParsedEntry[];
}

export interface ParsedEntry {
	lineIndex: number;
	entry: SessionEntry;
}

export interface LogRecord {
	op: "edit" | "delete" | "reparent";
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionHeader(entry: FileEntry): entry is SessionHeader {
	return entry.type === "session";
}

/** Tab-separated; matches how pi itself rejects/migrates old files. */
const ENDING = "\n";

export function readSessionDocument(path: string): SessionDocument {
	const raw = readFileSync(path, "utf8");
	const hasTrailingNewline = raw.endsWith(ENDING);
	const lines = raw.split(ENDING);
	if (hasTrailingNewline) lines.pop();

	let header: SessionHeader | undefined;
	const entries: ParsedEntry[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		if (!line || !line.trim()) continue;

		let parsed: FileEntry;
		try {
			parsed = JSON.parse(line) as FileEntry;
		} catch {
			continue; // pi drops malformed lines too; we keep the raw text untouched
		}

		if (isSessionHeader(parsed)) {
			header ??= parsed;
			continue;
		}
		entries.push({ lineIndex, entry: parsed });
	}

	if (!header) {
		throw new Error(`${path} 不是有效的 pi session 文件（没有 session header）`);
	}
	if (header.version !== CURRENT_SESSION_VERSION) {
		throw new Error(
			`session 版本是 ${header.version ?? "1"}，当前 pi 期望 ${CURRENT_SESSION_VERSION}；拒绝改写`,
		);
	}

	assertUniqueIds(entries);
	return { path, lines, header, entries };
}

function assertUniqueIds(entries: ParsedEntry[]): void {
	const seen = new Set<string>();
	for (const { entry } of entries) {
		if (seen.has(entry.id)) {
			throw new Error(`session 文件里 entry id 重复：${entry.id}`);
		}
		seen.add(entry.id);
	}
}

// ---------------------------------------------------------------------------
// Content rewriting
// ---------------------------------------------------------------------------

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
	return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

/**
 * Replace every text block with a single text block at the first text position.
 * Non-text blocks (thinking, toolCall, image) keep their place and content.
 */
export function rebuildContent(content: unknown, newText: string): unknown[] {
	if (!Array.isArray(content)) {
		return [{ type: "text", text: newText }];
	}

	const result: unknown[] = [];
	let wroteText = false;
	for (const block of content) {
		if (isTextBlock(block)) {
			if (!wroteText) {
				result.push({ type: "text", text: newText });
				wroteText = true;
			}
			continue;
		}
		result.push(block);
	}

	if (!wroteText) {
		result.push({ type: "text", text: newText });
	}
	return result;
}

// ---------------------------------------------------------------------------
// Editing one message
// ---------------------------------------------------------------------------

export interface EditOptions {
	path: string;
	entryId: string;
	newText: string;
}

export interface EditOutcome {
	changedLines: number;
}

export function applyEdit(options: EditOptions): EditOutcome {
	const document = readSessionDocument(options.path);
	const target = document.entries.find((candidate) => candidate.entry.id === options.entryId);
	if (!target) {
		throw new Error(`找不到 entry ${options.entryId}`);
	}
	if (target.entry.type !== "message") {
		throw new Error(`entry ${options.entryId} 不是消息，不能编辑`);
	}

	const originalLine = document.lines[target.lineIndex] ?? "";
	const message = target.entry.message;
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
		throw new Error(`entry ${options.entryId} 的 role 是 ${message.role}，不能编辑`);
	}
	const rewritten: SessionEntry = {
		...target.entry,
		message: { ...message, content: rebuildContent(message.content, options.newText) } as typeof message,
	};

	const lines = [...document.lines];
	lines[target.lineIndex] = JSON.stringify(rewritten);

	commit(document, lines, [{ op: "edit", ts: new Date().toISOString(), entryId: options.entryId, originalLine }], {
		expectedEntryCount: document.entries.length,
		expectedIds: new Set(document.entries.map(({ entry }) => entry.id)),
	});

	return { changedLines: 1 };
}

// ---------------------------------------------------------------------------
// Dropping one turn
// ---------------------------------------------------------------------------

export interface RemoveOptions {
	path: string;
	/** The user entry that starts the turn. */
	userId: string;
	/** Active branch order, as reported by the running session. */
	branchIds: string[];
}

export interface RemoveOutcome {
	removed: number;
	reparented: number;
}

export function applyRemove(options: RemoveOptions): RemoveOutcome {
	const document = readSessionDocument(options.path);
	const byId = new Map(document.entries.map((parsed) => [parsed.entry.id, parsed]));
	const branchPosition = new Map(options.branchIds.map((id, index) => [id, index]));

	const start = branchPosition.get(options.userId);
	if (start === undefined) {
		throw new Error(`entry ${options.userId} 不在当前分支上`);
	}
	const startEntry = byId.get(options.userId)?.entry;
	if (!startEntry || startEntry.type !== "message" || startEntry.message.role !== "user") {
		throw new Error(`entry ${options.userId} 不是 user 消息，不能作为一轮的起点`);
	}

	let end = options.branchIds.length;
	for (let index = start + 1; index < options.branchIds.length; index++) {
		const id = options.branchIds[index];
		if (!id) continue;
		const entry = byId.get(id)?.entry;
		if (entry?.type === "message" && entry.message.role === "user") {
			end = index;
			break;
		}
	}

	const segmentIds = options.branchIds.slice(start, end);
	const removableIds = new Set<string>();
	for (const id of segmentIds) {
		const entry = byId.get(id)?.entry;
		if (!entry) continue;
		// Bookkeeping (usage / model_change / label / context_edit / custom /
		// session_info) stays: it is not part of what the turn said.
		if (entry.type === "message" || entry.type === "custom_message") {
			removableIds.add(id);
		}
	}
	if (removableIds.size === 0) {
		throw new Error("这一轮没有可删除的消息");
	}

	assertNoCompactionAnchor(document, removableIds);
	assertNoOtherBranchChildren(document, removableIds, options.branchIds);

	const replacementParentId = start > 0 ? (options.branchIds[start - 1] ?? null) : null;
	const parsedByLine = new Map(document.entries.map((parsed) => [parsed.lineIndex, parsed]));

	const lines: string[] = [];
	const records: LogRecord[] = [{ op: "delete", ts: new Date().toISOString(), removedLines: [] as string[] }];
	const removedLines = records[0]?.removedLines as string[];
	let removed = 0;
	let reparented = 0;

	for (let lineIndex = 0; lineIndex < document.lines.length; lineIndex++) {
		const line = document.lines[lineIndex] ?? "";
		const parsed = parsedByLine.get(lineIndex);
		if (!parsed) {
			lines.push(line); // header or a malformed line pi itself ignores
			continue;
		}

		if (removableIds.has(parsed.entry.id)) {
			removedLines.push(line);
			removed++;
			continue;
		}

		const parentId = parsed.entry.parentId;
		if (parentId && removableIds.has(parentId)) {
			const rewritten = { ...parsed.entry, parentId: replacementParentId } as SessionEntry;
			lines.push(JSON.stringify(rewritten));
			records.push({
				op: "reparent",
				ts: new Date().toISOString(),
				entryId: parsed.entry.id,
				oldParentId: parentId,
				newParentId: replacementParentId,
			});
			reparented++;
			continue;
		}

		lines.push(line);
	}

	const expectedIds = new Set(document.entries.map(({ entry }) => entry.id));
	for (const id of removableIds) expectedIds.delete(id);

	commit(document, lines, records, {
		expectedEntryCount: document.entries.length - removed,
		expectedIds,
	});

	return { removed, reparented };
}

/**
 * A compaction entry anchors the retained range with firstKeptEntryId. Dropping
 * that entry makes buildContextEntries() keep nothing from the summarized range.
 */
function assertNoCompactionAnchor(document: SessionDocument, removableIds: Set<string>): void {
	for (const { entry } of document.entries) {
		if (entry.type !== "compaction") continue;
		if (removableIds.has(entry.firstKeptEntryId)) {
			throw new Error(
				`这一轮包含被压缩摘要引用的起始条目（${entry.firstKeptEntryId}），删除会让摘要之后的上下文静默丢失；拒绝删除`,
			);
		}
	}
}

/** Entries outside the active branch must not point into the removed range. */
function assertNoOtherBranchChildren(
	document: SessionDocument,
	removableIds: Set<string>,
	branchIds: string[],
): void {
	const onBranch = new Set(branchIds);
	for (const { entry } of document.entries) {
		if (onBranch.has(entry.id)) continue;
		if (entry.parentId && removableIds.has(entry.parentId)) {
			throw new Error(
				`另一条分支的 entry ${entry.id} 挂在被删条目 ${entry.parentId} 下面；先在 /tree 处理掉那条分支`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

interface CommitExpectation {
	expectedEntryCount: number;
	expectedIds: Set<string>;
}

function commit(
	document: SessionDocument,
	lines: string[],
	records: LogRecord[],
	expectation: CommitExpectation,
): void {
	appendLog(document.path, records);
	writeAtomic(document.path, lines);
	verifyWritten(document.path, expectation);
}

function appendLog(sessionPath: string, records: LogRecord[]): void {
	const payload = records.map((record) => JSON.stringify(record)).join(ENDING) + ENDING;
	appendFileSync(`${sessionPath}.psm-log`, payload);
}

function writeAtomic(sessionPath: string, lines: string[]): void {
	const tmp = `${sessionPath}.psm-tmp`;
	writeFileSync(tmp, lines.join(ENDING) + ENDING);
	renameSync(tmp, sessionPath);
}

function verifyWritten(sessionPath: string, expectation: CommitExpectation): void {
	const reread = readSessionDocument(sessionPath);
	const ids = new Set(reread.entries.map(({ entry }) => entry.id));

	if (reread.entries.length !== expectation.expectedEntryCount) {
		throw new Error(
			`写后校验失败：条目数 ${reread.entries.length}，期望 ${expectation.expectedEntryCount}（原文件已被 psm-log 记录）`,
		);
	}
	for (const id of expectation.expectedIds) {
		if (!ids.has(id)) throw new Error(`写后校验失败：条目 ${id} 丢失`);
	}
	for (const { entry } of reread.entries) {
		const parentId = entry.parentId;
		if (parentId && !ids.has(parentId)) {
			throw new Error(`写后校验失败：条目 ${entry.id} 的 parentId ${parentId} 不可解析`);
		}
	}
}
