/**
 * Windowed single-select list for extension commands.
 *
 * ctx.ui.select() renders every option as its own line and never scrolls, so any
 * list longer than the visible area becomes blind selection (verified: 200 options,
 * cursor moves off-screen). Pi's own long lists (/tree, /resume, /model) build a
 * custom component instead — this is the same idea, flat and minimal.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	getKeybindings,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export interface PickerItem {
	id: string;
	label: string;
}

class PickerComponent extends Container implements Focusable {
	focused = false;

	private items: PickerItem[];
	private selectedIndex: number;
	private title: string;
	private theme: Theme;
	private tui: TUI;
	private done: (result: string | undefined) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		title: string,
		items: PickerItem[],
		initialIndex: number,
		done: (result: string | undefined) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.items = items;
		this.selectedIndex = Math.max(0, Math.min(initialIndex, items.length - 1));
		this.done = done;
	}

	private get maxVisible(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(5, Math.min(15, Math.floor(rows * 0.4)));
	}

	private windowStart(): number {
		const maxVisible = this.maxVisible;
		if (this.items.length <= maxVisible) return 0;
		const centered = this.selectedIndex - Math.floor(maxVisible / 2);
		return Math.max(0, Math.min(centered, this.items.length - maxVisible));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const page = Math.max(1, this.maxVisible - 1);

		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - page);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + page);
			this.tui.requestRender();
			return;
		}
		if (data === "g") {
			this.selectedIndex = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "G") {
			this.selectedIndex = this.items.length - 1;
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.done(this.items[this.selectedIndex]?.id);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		}
	}

	private border(width: number, hiddenAbove: number, hiddenBelow: number): string {
		let text = "─".repeat(Math.max(0, width));
		if (hiddenAbove > 0) {
			const marker = `↑ ${hiddenAbove}`;
			text = text.slice(0, 2) + this.theme.fg("muted", marker) + text.slice(2 + visibleWidth(marker));
		}
		if (hiddenBelow > 0) {
			const marker = `↓ ${hiddenBelow}`;
			const start = Math.max(0, width - visibleWidth(marker) - 2);
			text = text.slice(0, start) + this.theme.fg("muted", marker) + text.slice(start + visibleWidth(marker));
		}
		return text;
	}

	render(width: number): string[] {
		const maxVisible = this.maxVisible;
		const start = this.windowStart();
		const end = Math.min(start + maxVisible, this.items.length);
		const labelWidth = Math.max(10, width - 4);

		const lines: string[] = [];
		lines.push(this.border(width, start, this.items.length - end));
		lines.push(` ${this.theme.fg("accent", this.theme.bold(this.title))}`);
		lines.push("");

		for (let i = start; i < end; i++) {
			const item = this.items[i];
			if (!item) continue;
			const label = truncateToWidth(item.label, labelWidth);
			lines.push(
				i === this.selectedIndex
					? ` ${this.theme.fg("accent", `→ ${label}`)}`
					: `   ${this.theme.fg("text", label)}`,
			);
		}

		lines.push("");
		lines.push(
			` ${this.theme.fg("muted", `↑↓/jk 移动   PgUp/PgDn 翻页   Enter 选择   Esc 取消   (${this.selectedIndex + 1}/${this.items.length})`)}`,
		);
		lines.push(this.border(width, 0, 0));
		return lines;
	}
}

/** Show a windowed list and resolve to the chosen item id, or undefined on cancel. */
export function pickItem(
	ctx: ExtensionCommandContext,
	title: string,
	items: PickerItem[],
	initialIndex = 0,
): Promise<string | undefined> {
	if (items.length === 0) return Promise.resolve(undefined);
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		return new PickerComponent(tui, theme, title, items, initialIndex, done);
	});
}
