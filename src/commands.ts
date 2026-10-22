/**
 * Command wiring for /psm-edit and /psm-remove.
 *
 * Flow: pre-flight → pick a target → collect the new text / confirm → rewrite the
 * session file and log it → reload the same file so the transcript redraws from
 * disk and the next request sees the new content.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { editableItems, turnItems } from "./items.ts";
import { preview, textOf } from "./messages.ts";
import { applyEdit, applyRemove } from "./session-file.ts";
import { pickItem } from "./ui.ts";

interface Prepared {
	file: string;
	branch: SessionEntry[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function countImages(entry: SessionEntry): number {
	if (entry.type !== "message") return 0;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return 0;
	const content: unknown = message.content;
	if (!Array.isArray(content)) return 0;
	return content.filter(
		(block: unknown) =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image",
	).length;
}

/** Shared pre-flight: interactive UI, idle agent, session already persisted. */
async function prepare(ctx: ExtensionCommandContext): Promise<Prepared | undefined> {
	if (!ctx.hasUI) {
		return undefined;
	}

	await ctx.waitForIdle();

	const file = ctx.sessionManager.getSessionFile();
	if (!file) {
		ctx.ui.notify("当前会话没有落盘文件，无法修改", "warning");
		return undefined;
	}

	return { file, branch: ctx.sessionManager.getBranch() };
}

/**
 * Reload the session we just rewrote. On success pi draws the whole transcript
 * from disk and prints "Resumed session" itself; on failure the file is already
 * changed, so the only honest thing left is to say so.
 *
 * The outcome is appended to the psm log: when the reload dies after teardown the
 * old ctx is stale and a notify through it throws, which would otherwise leave
 * the failure invisible.
 */
async function reload(ctx: ExtensionCommandContext, file: string, successText: string): Promise<void> {
	let warning: string | undefined;
	try {
		const result = await ctx.switchSession(file, {
			withSession: async (newCtx) => {
				newCtx.ui.notify(successText, "info");
			},
		});
		if (result.cancelled) {
			warning = "文件已修改，但重载被取消；请手工执行 /resume";
			logReload(file, "cancelled");
		} else {
			logReload(file, "ok");
		}
	} catch (error) {
		warning = `文件已修改，但重载失败（${errorMessage(error)}）；请手工执行 /resume`;
		logReload(file, `error: ${errorMessage(error)}`);
	}

	if (!warning) return;
	try {
		ctx.ui.notify(warning, "warning");
	} catch {
		// Old context already stale; the psm log above holds the outcome.
	}
}

function logReload(file: string, outcome: string): void {
	try {
		appendFileSync(`${file}.psm-log`, `${JSON.stringify({ op: "reload", ts: new Date().toISOString(), outcome })}\n`);
	} catch {
		// Logging is best-effort; never turn it into a second failure.
	}
}

async function handleEdit(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const prepared = await prepare(ctx);
	if (!prepared) return;

	const items = editableItems(prepared.branch);
	if (items.length === 0) {
		ctx.ui.notify("当前分支没有可编辑的消息", "info");
		return;
	}

	const targetId = await pickItem(ctx, "选择要编辑的消息", items, items.length - 1);
	if (!targetId) return;

	const entry = prepared.branch.find((candidate) => candidate.id === targetId);
	if (!entry) return;

	const original = textOf(entry) ?? "";
	const images = countImages(entry);
	const title = images > 0 ? `编辑消息（含 ${images} 张图片，图片将保留）` : "编辑消息";

	const edited = await ctx.ui.editor(title, original);
	if (edited === undefined) return;
	if (edited === original) {
		ctx.ui.notify("内容没有变化，未写入", "info");
		return;
	}

	try {
		applyEdit({ path: prepared.file, entryId: targetId, newText: edited });
	} catch (error) {
		ctx.ui.notify(`psm-edit 失败：${errorMessage(error)}`, "error");
		return;
	}

	await reload(ctx, prepared.file, `已修改消息：${preview(edited, 40)}`);
}

async function handleRemove(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const prepared = await prepare(ctx);
	if (!prepared) return;

	const items = turnItems(prepared.branch);
	if (items.length === 0) {
		ctx.ui.notify("当前分支没有可删除的轮次", "info");
		return;
	}

	const targetId = await pickItem(ctx, "选择要删除的一轮", items, items.length - 1);
	if (!targetId) return;

	const label = items.find((item) => item.id === targetId)?.label ?? targetId;
	const confirmed = await ctx.ui.confirm("删除这一轮", `${label}\n\n删除后无法从会话文件恢复，只能从 .psm-log 取回原文。`);
	if (!confirmed) return;

	try {
		const outcome = applyRemove({ path: prepared.file, userId: targetId, branchIds: prepared.branch.map((entry) => entry.id) });
		await reload(ctx, prepared.file, `已删除这一轮（${outcome.removed} 条消息）`);
	} catch (error) {
		ctx.ui.notify(`psm-remove 失败：${errorMessage(error)}`, "error");
	}
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("psm-edit", {
		description: "编辑当前会话中的一条历史消息",
		handler: handleEdit,
	});
	pi.registerCommand("psm-remove", {
		description: "删除当前会话中的一整轮（一条 user 及其后续）",
		handler: handleRemove,
	});
}
