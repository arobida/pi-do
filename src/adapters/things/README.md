# Things 3 adapter

Syncs pi-do's todo store with [Things 3](https://culturedcode.com/things/) on macOS. Writes use the [Things URL scheme](https://culturedcode.com/things/support/articles/2803573/); reads use Things' AppleScript dictionary through `osascript`, because the URL scheme cannot read tasks.

## Connect

1. Install Things 3 on the Mac that runs Pi.
2. Enable the URL scheme and copy the auth token: Things → Settings → General → Enable Things URLs → Manage.
3. Save the token in Pi:
   ```
   /todos connect things <token>
   ```
   It is written to `~/.pi-do/adapters/things.json` with `0600` permissions, never to a `config.jsonl` (which may be committed). `PI_DO_THINGS_TOKEN` overrides the file.
4. Turn sync on in a pi-do `config.jsonl` (global `~/.pi-do/config.jsonl` or the project's):
   ```json
   {"adapters": {"things": {"sync": true}}}
   ```
5. Run `/reload` in Pi. On the first read, macOS asks to let Pi's terminal control Things 3 (System Settings → Privacy & Security → Automation); allow it.

To disconnect, set `"sync": false` or remove the entry, and delete `~/.pi-do/adapters/things.json`. Tasks already synced stay on both sides.

## Capabilities

| Field | pi-do → Things | Things → pi-do |
|---|---|---|
| Create to-do | yes | yes |
| Name → title (todo.txt priority, `+project`, `@context` stay as text) | yes | yes |
| Description → notes | yes | yes |
| Completed (and un-completed) | yes | yes |

- Two-way, using the same rules as every adapter: each list or change in pi-do syncs both ways; per field, a change on one side since the last sync is copied across, and if both changed, pi-do wins.
- Changes made in Things are pulled on the next pi-do action and before each prompt.
- State: links and last-synced copies live in `sync/things.jsonl` next to the store's `config.jsonl`.

## Limitations

- macOS only.
- The first sync pulls in every to-do Things returns, including the Logbook. Canceled to-dos are skipped.
- Not synced: started time, result, parent/subtasks (Things has projects, headings and checklists rather than subtasks), and Things' when/deadline, tags, areas, projects, headings and checklists.
- Deletions are never propagated in either direction.
- The URL scheme does not return the new to-do's id to a command-line caller. pi-do tags the notes with a temporary `[pi-do:<id>]` marker, waits up to about 5 seconds to find the to-do, then removes the marker. If Things is slower than that, the sync fails and is retried; the retry can create a duplicate.
- Adding uses `open -g` so Things stays in the background, but macOS may still launch it.
- No live updates: Things has no folder to watch.
- Sync failures show as a notice and do not block the local change.
