# Dex adapter

Syncs pi-do's todo store with [Dex](https://github.com/dcramer/dex) through the `dex` CLI.

## Connect

1. Install `dex` and make sure it is on `PATH` (`dex --version`).
2. Optional: run `dex init` (global `~/.config/dex/dex.toml`) or add a project `.dex/config.toml` to choose where Dex stores tasks. Without either, pi-do uses temporary per-session Dex storage.
3. Turn sync on in a pi-do `config.json` (global `~/.pi-do/config.json` or the project's):
   ```json
   {"adapters": {"dex": {"sync": true}}}
   ```
4. Run `/reload` in Pi. Existing Dex tasks are pulled into pi-do on the first sync, and pi-do tasks are pushed to Dex.

To disconnect, set `"sync": false` or remove the entry. Tasks already synced stay on both sides.

## Capabilities

| Field | pi-do → Dex | Dex → pi-do |
|---|---|---|
| Create task | yes | yes |
| Name (todo.txt priority, `+project`, `@context` as text) | yes | yes |
| Description | yes | yes |
| Parent (subtasks) | yes | yes |
| Started | yes | yes |
| Completed + result | yes | yes |

- Two-way: each list or change in pi-do syncs both ways. Changes made in Dex by other agents are pulled when Dex's storage folder changes (file storage engine only), and before each prompt.
- Conflicts: per field, a change on one side since the last sync is copied across. If both sides changed the same field, pi-do wins.
- State: links and last-synced copies live in `sync/dex.jsonl` next to the store's `config.json`.
- Completing in Dex uses `--no-commit --force`.

## Limitations

- Deletions are never propagated in either direction.
- Dex cannot un-complete or un-start a task, or change a completed task's result; those changes stay in pi-do only.
- Clearing a description in pi-do does not clear it in Dex.
- Not synced: Dex's numeric priority, blockers (`blockedBy`/`blocks`), linked commits, metadata, archived tasks, and GitHub/Shortcut sync.
- Dex storage outside the file engine (no local folder) is only re-synced on pi-do actions and before each prompt, not live.
- Sync failures show as a notice and do not block the local change; it retries on the next sync.
