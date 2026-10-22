/**
 * Command wiring for /psm-edit and /psm-remove.
 *
 * Both commands run the same pre-flight (interactive UI, idle agent, session file
 * on disk), let the user pick a target, and then hand off to the rewrite step.
 * The rewrite itself lands in src/session-file.ts in the next step.
 */
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { editableItems, turnItems } from "./items.ts";
import { pickItem } from "./ui.ts";

interface Prepared {
	file: string;
	branch: SessionEntry[];
}

/**
 * Shared pre-flight: interactive UI, idle agent, session already persisted.
 * Returns undefined (after notifying) when the command must not proceed.
 */
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

	ctx.ui.notify(`psm-edit：选中 ${targetId}（改写逻辑待接入）`, "info");
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

	ctx.ui.notify(`psm-remove：选中 ${targetId}（删除逻辑待接入）`, "info");
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
