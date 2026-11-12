# Task-tracker strengths applied to pi-do

These are the strengths found in `.agents/research/repo-research.md`, each checked against pi-do. Written 2026-11-12 from the research doc and the codebase map only. The source wasn't opened, so the "How" notes are directions, not checked designs.

## Strengths, and whether pi-do should use them

| # | Strength (tool) | Use in pi-do? | How |
|---|---|---|---|
| 1 | **Plain text people can read and edit by hand** (todo.txt) | ✅ Already done | pi-do's store is todo.txt. Keep it that way. |
| 2 | **One task per line, so git diffs stay small and merges are clean** (Dex JSONL, todo.txt) | ✅ Already done | todo.txt already writes one task per line. If you commit the store, a doc note is enough. |
| 3 | **Ids that can't clash** (Beads hash ids, Taskwarrior UUIDs) | ✅ Already done | `piid:` already does this. You could shorten them to something like `bd-a1b2` so agents can type them. That's optional. |
| 4 | **A fixed, typed task record** (Dex Zod) | ✅ Cheap | Check tags in `parseTodo`, and treat bad `piparent:` or `piid:` values as errors instead of letting them through. Leave out Zod unless it's already installed. |
| 5 | **A result written when a task is completed** (Dex `result`) | ✅ Already done | That's `piresult:`. |
| 6 | **Task state worked out from fields, with no status enum** (Dex `completed` + `started_at`) | ✅ Already done | `x` plus `pistart:` already work this way. Don't add a status field. |
| 7 | **A "ready to work on" query** (Beads `bd ready`) | ⚠️ Only if you add dependencies | Add a `piblocks:<id>` tag, stored **on one side only**. Then "ready" is a filter: open tasks whose blockers are all done. It fits in about 10 lines in the task panel. This is the one real feature worth considering. |
| 8 | **Links stored on both sides** (Dex `blocks`/`blockedBy`, `children`) | ❌ No | Each link change would have to update two lines. Store each link on one side and work out the reverse when reading, as `piparent:` already does. |
| 9 | **Unknown fields kept, not dropped** (Taskwarrior keeps unrecognized values and user fields) | ✅ Check this | Make sure `todoLine(parseTodo(x))` round-trips tags it doesn't know. If it drops them, that's a data-loss bug, worth one test. |
| 10 | **A change log, undo and per-property conflict resolution** (TaskChampion) | ❌ Not now | git already covers history and undo for a text file. A change log is worth it only if two machines sync without git. |
| 11 | **Many kinds of links in an edge table** (Beads, 19 types) | ❌ No | Needs a database. Too much for a todo.txt store. |
| 12 | **Leases on claimed tasks** (Beads `LeaseExpiresAt`) | ⚠️ Maybe | Useful only if several agents grab tasks at once. `withLock` already stops them writing over each other. A stale `pistart:` could be the lease, with no new field. |
| 13 | **Deferred tasks** (Beads `DeferUntil`; Taskwarrior `wait`) | ⚠️ Cheap if you want it | Add a `t:YYYY-MM-DD` tag (an existing todo.txt convention) and hide the task until that date. |
| 14 | **Archiving or compacting finished tasks** (Dex `archive.jsonl`, Beads compaction) | ✅ Cheap | Move `x` lines into `<name>.done.jsonl`, the same idea as todo.txt's `done.txt` so the main file stays small. |
| 15 | **Urgency ranking** (Taskwarrior) | ❌ No | todo.txt's `(A)` priority is enough. |
| 16 | **Sync to outside tools** (Dex GitHub/Shortcut; Beads Dolt push) | ✅ Already done | The Dex and Things adapters do this. |
| 17 | **One-file-per-task Markdown with acceptance criteria** (Backlog.md) | ❌ No | It works against the one-line model. `pidesc:` is enough. |

## Worth doing, smallest first

1. **Round-trip test for unknown tags (#9).** This protects user data.
2. **Archive to a done file (#14).**
3. **A `piblocks:` tag plus a ready filter (#7)**, but only if you actually want dependencies.

Everything else was skipped on purpose: it either duplicates what git or todo.txt already does, or it needs a database.

## Open question

Nobody has checked yet whether `parseTodo`/`todoLine` keep unknown tags. If they don't, #9 is a live bug where data can be lost.

## Idea: machine-readable links from Markdown files to tasks

Goal: a Markdown file (a plan, spec or note) links to a pi-do task, and the link alone says exactly where the task is. Nothing has to be searched to follow it.

**Format:** a URI that names the store and the task id:

```md
See [fix login bug](pido://<store>/<piid>) for details.
```

- `<store>` says which todo file holds the task: `project` (the repo's store) or `global` (the home store). Either way, the link is enough to open the right file.
- `<piid>` is the task's existing id. It never changes and is unique, so the link survives edits, reordering and branches. Line numbers would break.
- The link renders as a normal Markdown link. A tool can read it with one regex: `/pido:\/\/(\w+)\/([\w-]+)/`.
- Following a link means opening `<store>` and taking the line tagged `piid:<piid>`. That's a direct lookup, not a search.

**Task → Markdown:** a task can link to a Markdown file with a `pidoc:` tag:

```
Fix login bug piid:<piid> pidoc:docs/plans/login.md#approach
```

- The path is relative to the repo root, and an optional `#heading` points at a section. Following the link opens the file directly.
- A task can have more than one `pidoc:` tag.
- The two directions are independent: a doc linking to a task doesn't require the task to link back. If you want both, add both on purpose. This avoids the two-sided upkeep from #8.
- Spaces in paths break todo.txt tags, so encode them as `%20`.
- This needs the unknown-tag round-trip (#9) to work, or the tag gets dropped.

**Dead links:** if the `piid` isn't found, the task was deleted or archived. Check the done file next (#14), then report the link as dead.

**Open question:** are `piid`s short enough to type by hand? If not, this depends on the short-id option in #3.

## Idea: one file per task state

Proposal:
- `todos.jsonl`: every task that isn't completed
- `doing.jsonl`: the tasks being worked on now
- `done.jsonl`: every completed task

**For:**
- The agent and the panel read only the file they need. `doing` stays tiny.
- `done` grows forever but never gets in the way. This is the same as #14.

**Against:**
- Changing a task's state means deleting it from one file and adding it to another. A crash in between loses or duplicates the task, so both writes need `withLock` and a careful order: write the new file first, then remove from the old one.
- `doing` duplicates information `pistart:` already has (#6). Two sources of truth can disagree.
- Does `todos` include the `doing` tasks? If it does, they're stored twice. If not, "every open task" means reading two files.
- Links (`pido://<store>/<piid>`) can't name a file, because the task moves between them. Following a link has to check all three.
- `.jsonl` replaces todo.txt, so tasks can no longer be edited by hand as plain lines (#1), and the Dex and Things adapters need to change. That's a separate decision. It doesn't come with splitting by state.

**Recommendation:** split into two files, `<name>.todos.jsonl` (open tasks, with `pistart:` marking the doing ones) and `<name>.done.jsonl` (completed tasks). That gets the main benefit with one state move instead of three, and it's the todo.txt convention. Change the format to JSONL only if there's a separate reason.


Note: the store file is `<name>.todos.jsonl` (`src/store.ts:95`). Each line is JSON that wraps one todo.txt line, for example `{"todo":"Hello World piid:<uuid>"}`. The todo.txt text inside comes from `todoLine` (`src/todo.ts:22`).
