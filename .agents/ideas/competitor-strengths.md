# Task-tracker strengths applied to pi-do

This doc compares the strengths listed in `.agents/research/repo-research.md` with pi-do. Rewritten 2026-11-13 and checked against the code after commit `69ecab0`, which moved the store to typed JSONL. The file references below are from that check.

## How pi-do works today

- **Store.** `<base>/todos/<name>.todos.jsonl` holds one `Task` JSON record per line (`src/store.ts:97`, `src/todo.ts:4`).
  - Every write rewrites the whole file through a tmp file and `rename` (`src/tasks.ts:30`), inside `withLock` (`src/tasks.ts:11`).
  - Reads skip a torn last line (`src/util.ts:33`).
- **Record.** `toTask` rejects unknown keys and checks field types (`src/todo.ts:21`). Status is `completed` plus `started_at`. There's no status enum.
- **Ids.** New tasks get a `randomUUID()` (`src/tasks.ts:70`). Imported lines without an id get `line-<12 hex>`.
- **todo.txt.** It's only an import/export format, handled by `parseTodo`/`todoLine` and the `/todos import` and `/todos export` commands (`src/tasks.ts:26,41`).
- **Sync.** Dex and Things sync both ways on Task fields through `src/adapters/sync.ts`.

## Strengths, and whether pi-do should use them

| # | Strength (tool) | Status | Notes |
|---|---|---|---|
| 1 | Plain text people can read (todo.txt) | ✅ Partly | JSONL is readable but awkward to edit by hand. Export to todo.txt covers people who want plain lines. |
| 2 | One task per line, so diffs stay small (Dex JSONL) | ✅ Done | Keys are written in a fixed order by `clean` (`src/todo.ts:37`), so diffs stay stable. |
| 3 | Ids that can't clash (Beads, Taskwarrior) | ✅ Done | UUIDs. Short ids would only help a person typing them, and agents paste them, so skip short ids. |
| 4 | A fixed, typed record (Dex Zod) | ✅ Done | `toTask`. **Gap:** `parent` is checked as an existing id only on `create` (`src/tasks.ts:68`), not on `put`/sync or import. |
| 5 | A result written on completion (Dex) | ✅ Done | `complete` sets `result` (`src/tasks.ts:77`). |
| 6 | State worked out from fields (Dex) | ✅ Done | `completed` + `started_at`. Don't add a status field. |
| 7 | A "ready to work on" query (Beads `bd ready`) | ✅ Worth it | Doesn't exist yet; `parent` is the only relation. Add an optional field `blocks?: string[]` stored on one side. "Ready" = open tasks whose blockers are all completed. That's a new filter in the panel. |
| 8 | Links stored on both sides (Dex) | ❌ No | Store each link on one side and work out the reverse when reading, as `parent` does. |
| 9 | Unknown fields kept (Taskwarrior) | ✅ Done | Unknown todo.txt tags (`due:`, `t:`, `+proj`) stay in `name` when imported. The JSONL record rejects unknown keys on purpose. |
| 10 | Change log, undo (TaskChampion) | ❌ No | Git covers history. |
| 11 | An edge table with many link types (Beads) | ❌ No | Needs a database. |
| 12 | Claims on tasks (Beads leases, made event-driven) | ✅ Worth it | Real gap: `start` overwrites `started_at` with no check (`src/tasks.ts:76`), so two agents can claim the same task, and a crashed agent's claim never ends. A time limit can't work, because task length is unpredictable. Instead, release claims on events (see below). Separately, `withLock`'s 10s stale window (`src/util.ts:7-21`) can break a held file lock. |
| 13 | Deferred tasks (Beads, Taskwarrior `wait`) | ⚠️ Optional | Not present. It would be a `defer_until?: string` field plus a panel filter. |
| 14 | Archiving finished tasks (Dex; Beads instead summarizes old closed tasks in place) | ✅ Worth it | Not present. Completed tasks stay in the main file, and the panel filters them out (`src/index.ts:51`). |
| 15 | Urgency ranking (Taskwarrior) | ❌ No | `priority` A–Z is enough. |
| 16 | Sync to outside tools (Dex, Beads) | ✅ Done | The Dex and Things adapters. |
| 17 | One Markdown file per task (Backlog.md) | ❌ No | `description` is enough. |

## Worth doing, smallest first

1. **Check `parent` on `put` and import (#4).** Sync or import can currently write a dangling parent. Also reject a parent that would create a cycle, as Dex does. Write one test.
2. **Look at the lock's stale window (#12).** A 10s mtime timeout can break a lock that's still held. Refresh the lock's mtime while holding it, the way Beads renews leases with a heartbeat, or check whether the holder's pid is still alive before removing the lock.
3. **Archive to `<name>.done.jsonl` (#14).** Move completed tasks out under the lock. Write the done file first, then rewrite the main file.
   - Readers that need completed tasks (the panel's completed view, export, sync, and the `parent` walk) must also read the done file.
4. **Event-driven claims (#12).** Add `claimed_by?: string` (the Pi session id), set by `start`.
   - `start` refuses a task claimed by another live session unless `--force` is passed.
   - The claim is released when the task is completed, or when the session ends. The `session_shutdown` hook (`src/index.ts:174`) clears that session's claims.
   - A crash skips `session_shutdown`. To catch that, store the claimer's pid as well (`claimed_by: "<session>:<pid>"`) and treat the claim as free when `process.kill(pid, 0)` fails. This is the same liveness check the file lock should use.
   - Leave `started_at` alone; it still records when work began.
5. **Add `blocks` plus a ready filter (#7).** Ready = open, not claimed by a live session, all blockers completed. Goes well with #12: an agent asks for ready work and claims it.

Sources were checked against primary docs and code in `.agents/research/competitor-verification.md`. One more detail from there: `done.txt` and the `t:` threshold tag come from todo.txt clients, not from the todo.txt spec.

## Idea: links from Markdown files to tasks

Goal: a plan or spec links to a task, and the link alone says where the task is.

```md
See [fix login bug](pido://<project-id>/<task-id>).
```

- **Use the project's UUID, not a path or scope name.**
  - The store's path depends on its scope (`src/store.ts:76-82`), and `migrate` moves `todos/` between scopes (`src/store.ts:142`), so path-based links break.
  - The project id is stable. It's kept in the project's local config.json and in `~/.pi-do/projects/projects.jsonl`.
- **Following a link:** look up the project id in `projects.jsonl`, resolve its store, then find the task by `id`. If archiving (#14) exists, check the done file next. Otherwise report the link as dead.
- **Limits:**
  - Temp-scope stores can't be linked to after the session ends.
  - Overrides through `PI_DO_FILE` or the `file` setting (`src/store.ts:84`) bypass the registry.
- **Task → doc:** an optional field `docs?: string[]` holding repo-relative paths with an optional `#heading`. Store it on one side only, as #8 says.

## Idea: one file per task state (rejected)

The proposal was three files: `todos`, `doing` and `done`. Rejected:

- `doing` repeats what `started_at` already says, and the two can disagree.
- Each state change is a move between two files, which can lose or duplicate a task in a crash.
- Links would have to check three files.

Archiving completed tasks (#14) gets the useful part: the main file stays small.
