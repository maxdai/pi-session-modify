/**
 * Command wiring for /psm-edit and /psm-remove.
 *
 * Skeleton stage: both commands run the shared pre-flight checks (UI present,
 * not streaming, session file on disk) and report what they can currently see.
 * The rewrite itself lands in src/session-file.ts in the next step.
 */
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const EDITABLE_ROLES = new Set<string>(["user", "assistant", "toolResult"]);

interface Prepared {
	file: string;
	branch: SessionEntry[];
}

function isEditableMessage(entry: SessionEntry): boolean {
	return entry.type === "message" && EDITABLE_ROLES.has(entry.message.role);
}

function isUserMessage(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
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

	const editable = prepared.branch.filter(isEditableMessage);
	ctx.ui.notify(`psm-edit：当前分支有 ${editable.length} 条可编辑消息（改写逻辑待接入）`, "info");
}

async function handleRemove(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const prepared = await prepare(ctx);
	if (!prepared) return;

	const turns = prepared.branch.filter(isUserMessage);
	ctx.ui.notify(`psm-remove：当前分支有 ${turns.length} 轮可删除（删除逻辑待接入）`, "info");
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
