/**
 * pi-session-modify — edit or drop a single piece of the current session history.
 *
 * Commands:
 *   /psm-edit    rewrite one message (user / assistant / toolResult)
 *   /psm-remove  drop one turn (a user message and everything it caused)
 *
 * Both work by rewriting the affected lines of the session JSONL and then
 * reloading the same file with ctx.switchSession(), so the transcript redraws
 * from disk and the model sees the new content on the next request.
 *
 * Design notes: pi-session-modify-design.md
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./src/commands.ts";

export default function sessionModify(pi: ExtensionAPI): void {
	registerCommands(pi);
}
