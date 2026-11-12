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
| 14 | **Archiving or compacting finished tasks** (Dex `archive.jsonl`, Beads compaction) | ✅ Cheap | Move `x` lines into `done.txt` (the todo.txt convention) so the main file stays small. |
| 15 | **Urgency ranking** (Taskwarrior) | ❌ No | todo.txt's `(A)` priority is enough. |
| 16 | **Sync to outside tools** (Dex GitHub/Shortcut; Beads Dolt push) | ✅ Already done | The Dex and Things adapters do this. |
| 17 | **One-file-per-task Markdown with acceptance criteria** (Backlog.md) | ❌ No | It works against the one-line model. `pidesc:` is enough. |

## Worth doing, smallest first

1. **Round-trip test for unknown tags (#9).** This protects user data.
2. **Archive to `done.txt` (#14).**
3. **A `piblocks:` tag plus a ready filter (#7)**, but only if you actually want dependencies.

Everything else was skipped on purpose: it either duplicates what git or todo.txt already does, or it needs a database.

## Open question

Nobody has checked yet whether `parseTodo`/`todoLine` keep unknown tags. If they don't, #9 is a live bug where data can be lost.
