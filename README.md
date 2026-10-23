# @maxdai/pi-session-modify

A [Pi](https://github.com/earendil-works/pi-mono) extension that edits the current session's history in place: rewrite one message, or drop one whole turn.

Two commands:

| Command | What it does |
|---|---|
| `/psm-edit` | Pick one message on the current branch (`user` / `assistant` / `toolResult`), edit its text in Pi's own editor, then reload |
| `/psm-remove` | Pick one turn (a `user` message and everything it caused) and delete it, then reload |

Both work by rewriting the affected lines of the session JSONL and reloading that same file, so the transcript redraws from disk and the model sees the new content on the next request.

## Install

```bash
pi install npm:@maxdai/pi-session-modify
```

Or add it to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@maxdai/pi-session-modify"]
}
```

## Usage

```
/psm-edit      → list of messages → pick one → edit → Enter
/psm-remove    → list of turns    → pick one → confirm
```

- The list is windowed (`↑↓` / `jk` / `PgUp` `PgDn` / `g G`), oldest at the top, cursor starts on the newest entry
- `/psm-edit` opens Pi's editor: `Enter` submit, `Shift+Enter` newline, `Ctrl+G` hand off to `$EDITOR`
- Edits replace the text blocks only; `thinking`, `toolCall` and image blocks are kept as they are
- Text-only assistant turns (`toolCall` without text) are not offered for editing
- `/psm-remove` keeps bookkeeping entries (`usage`, `model_change`, labels, `context_edit`, …) and reparents them, so only the conversation goes away

## What it touches on disk

Next to the session file, in the same directory:

| File | Purpose |
|---|---|
| `<session>.psm-log` | append-only undo log: the original line for every edit, the removed lines for every delete, and every `parentId` change |
| `<session>.psm-tmp` | transient temp file, renamed over the session on success |

Nothing else. Files ending in `.psm-log` / `.psm-tmp` are ignored by Pi's session list.

## Safety

- The session file is version-checked before writing and re-read afterwards: entry count, id set and every `parentId` must still resolve, or the command reports a failure
- The log line is written **before** the session file, so a crash between the two leaves a record, not a silent change
- `/psm-remove` refuses to run when the turn contains a `compaction.firstKeptEntryId` (deleting it would silently drop the context that follows) or when another branch hangs off the removed range
- Writes are synchronous end to end, so a background writer in the same Pi process cannot interleave between reading and renaming
- The whole-file backup is deliberately not taken: it would discard entries appended after the edit. The `.psm-log` restores any single change exactly

## Requirements

- Pi ≥ 1.4.0
- Session format version 3
- Reloading happens through `ctx.switchSession()`. The TUI redraws itself; **pi-web** needs ≥ 1.2.10 to refresh the browser on an extension-driven session change (older versions: reload the page manually)
- One Pi process per session file (Pi does not lock session files)

## Limits

Not supported on purpose:

- inserting a new message into the middle of a history
- editing `custom_message` entries
- editing across branches (only the current branch is listed)
- remembering the previous selection (one command, one change, done)

## License

MIT
