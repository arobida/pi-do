# Task-tracker storage research

How agent and CLI task trackers store their tasks: file format, task record, relationships, sync.
Researched 2026-11-12. The Dex, Taskwarrior/TaskChampion and Beads sections come from source code on `main`. The todo.txt, Backlog.md and TodoWrite sections are from memory and were not checked.

## Summary

| Tool | Storage | Task shape | How tasks are linked | Sync |
|---|---|---|---|---|
| todo.txt | Plain text, one line per task | Free text + `key:value` tags | None | None |
| Backlog.md | One Markdown file per task + YAML frontmatter | Frontmatter fields + body sections | `dependencies`, `parent` id lists | git |
| Dex | JSONL, one task per line | Fixed, typed record (Zod) | Id lists stored on both sides (`blocks`/`blockedBy`, `parent_id`/`children`) | git (plus GitHub/Shortcut) |
| Taskwarrior 3 | SQLite (TaskChampion) | String→string map | `dep_<uuid>` keys | Change log, encrypted server |
| Beads | Dolt (SQL database with git-style versioning) | Large typed record, ~80 fields | Separate edge table, 19 edge types | `bd dolt push/pull` |

---

## Dex (dcramer/dex)

A task tracker for coding agents, used through a CLI or MCP server (npm package `@zeeg/dex`).

**Storage**
- `.dex/tasks.jsonl` holds active tasks. `.dex/archive.jsonl` holds archived tasks, compacted.
- Tasks live in the project (`.dex/`) or globally (`~/.dex/` or a custom path). Config is in `.dex/config.toml` or `~/.config/dex/dex.toml`. GitHub/Shortcut sync state is in `sync-state.json`.
- Why JSONL: it's meant to be committed to git. One task per line keeps diffs small and merges clean.
- Older versions stored one file per task (`.dex/tasks/{id}.json`). Current versions convert that to the JSONL file automatically.

**Task record** (`src/types.ts`)
```ts
Task {
  id: string
  parent_id: string | null           // the parent task, for epic → task → subtask
  name: string                        // ≤50KB, one-line title
  description: string = ""            // ≤50KB, context and approach
  priority: int 0..100 = 1
  completed: boolean = false
  result: string | null               // written when the task is completed
  metadata: {
    commit?:   { sha, message?, branch?, url?, timestamp? }
    github?:   { issueNumber, issueUrl, repo, state?: "open"|"closed" }
    shortcut?: { storyId, storyUrl, workspace, state?: "unstarted"|"started"|"done" }
    beads?:    { issueId, status?, issueType?, labels?, parentId?, blockerIds?, ... }
  } | null
  created_at, updated_at: ISO datetime
  started_at, completed_at: ISO datetime | null
  blockedBy: string[]   // ids of tasks that block this one
  blocks:    string[]   // ids of tasks this one blocks (the reverse of blockedBy)
  children:  string[]   // ids of child tasks (the reverse of parent_id)
}
```

**Notes**
- Relationships are stored on both sides: `blockedBy` and `blocks` mirror each other, and so do `parent_id` and `children`.
- There's no status enum. A task's state comes from `completed` plus `started_at`.
- Older formats are converted on read: `status: "completed"` becomes `completed: true`, and the old `{description, context}` fields become `{name, description}`.

---

## Taskwarrior 3 / TaskChampion

**Storage**
- Version 2.x used plain text files in `~/.task/` (`pending.data`, `completed.data`, `undo.data`, `backlog.data`), one task per line.
- Version 3.x (released March 2024) uses TaskChampion, a Rust library, and stores everything in one SQLite file: `~/.local/share/task/taskchampion.sqlite3`. It runs in WAL mode, so the file shouldn't sit on a network drive.
- Each device holds a **replica**, its own local copy of all task data. Replicas sync through a server and the data is encrypted. Version 3 no longer talks to the old `taskd` server.

**Tables** (`src/storage/sqlite/schema.rs`)
```sql
tasks       (uuid STRING PRIMARY KEY, data STRING)    -- data = JSON of TaskMap
operations  (id INTEGER PRIMARY KEY AUTOINCREMENT, data STRING,
             uuid GENERATED from data, synced bool DEFAULT false)
working_set (id INTEGER PRIMARY KEY, uuid STRING)     -- the short ids you type ("task 3 done")
sync_meta   (key STRING PRIMARY KEY, value STRING)
version     (...)                                     -- schema version
```

**Task record:** `TaskMap = HashMap<String, String>`. Every value is stored as a string, and anything structured is encoded into the key name:
```
status        pending | completed | deleted | recurring   (unrecognized values are kept, not dropped)
description   "Fix the bug"
entry, modified, start, end, due, wait, scheduled, until   (epoch timestamps)
project       "home.garden"
priority      "H"
tag_<name>         ""            one key per tag
dep_<uuid>         ""            one key per task this one depends on
annotation_<ts>    "note text"   one key per note
<anything else>                  user-defined fields (UDAs)
```

**Change log** (`src/operation.rs`)
```rust
enum Operation {
  Create { uuid },
  Delete { uuid, old_task: TaskMap },
  Update { uuid, property, old_value: Option<String>, value: Option<String>, timestamp },
  UndoPoint,   // marks where an undo stops
}
```
- `tasks` holds the current state. `operations` holds the history, and `synced=false` marks changes not yet sent to the server.
- Undo applies operations in reverse back to the last `UndoPoint`, using `old_value` / `old_task`.
- Sync exchanges operations, not tasks. Each operation changes one property, so conflicts are resolved property by property.
- Taskwarrior ranks tasks by a computed **urgency** score.

---

## Beads (steveyegge/beads, `bd`)

An issue tracker for AI agents that treats issues as a graph.

**Storage**
- A **Dolt** database: SQL with git-style commit, branch, merge (down to individual cells), push and pull.
- The default runs Dolt inside `bd`, with data in `.beads/embeddeddolt/` and one writer at a time. `bd init --server` uses a separate `dolt sql-server` instead.
- Ids look like `bd-a1b2`. They come from a hash, not a counter, so parallel branches and agents won't pick the same id.
- Tables (`internal/storage/schema/migrations/`): `issues`, `dependencies`, `labels`, `comments`, `events`, `metadata`, `config`, `wisps` (temporary issues that aren't synced), `issue_snapshots`, `compaction_snapshots`, `id_tombstones`, `federation_peers`, `routes`, plus the views `ready_issues_view` and `blocked_issues_view`.

**Issue record** (`internal/types/types.go`, core fields only)
```go
Issue {
  ID, Title, Description, Design, AcceptanceCriteria, Notes, SpecID
  Status      // open | in_progress | blocked | deferred | closed | pinned | hooked
  Priority    int        // 0 = P0, the most critical
  IssueType   // bug | feature | task | epic | chore | decision | message | spike | story | milestone | gate | molecule
  Assignee, Owner, EstimatedMinutes
  CreatedAt/By, UpdatedAt, StartedAt, ClosedAt, CloseReason, ClosedBySession
  DueAt, DeferUntil                         // DeferUntil hides it from `bd ready` until then
  LeaseExpiresAt, HeartbeatAt               // an agent's claim on the issue expires
  ExternalRef ("gh-9"), SourceSystem, Metadata (raw JSON)
  CompactionLevel, CompactedAt, OriginalSize   // old closed issues get summarized to save space
  Labels []string, Dependencies []*Dependency, Comments []*Comment
  Ephemeral, Pinned, IsTemplate               // also stored as "wisps"
  AwaitType/AwaitID/Timeout/Waiters           // "gates": wait on a CI run, PR, timer or human
  EventKind, Actor, Target, Payload           // issues can double as an event log
}
```

**Dependency** (an edge in the issue graph, stored in its own table)
```go
Dependency { ID (UUIDv5 of issue+target), IssueID, DependsOnID, Type, CreatedAt, CreatedBy, Metadata, ThreadID }
```
- Types that affect what's ready to work on: `blocks`, `parent-child`, `conditional-blocks`, `waits-for`.
- Types that are just links: `related`, `discovered-from`, `duplicates`, `supersedes`, `replies-to`, `relates-to`, `caused-by`, `tracks`, `until`, `validates`, `delegated-from`, `authored-by`, `assigned-to`, `approved-by`, `attests`.
- Parent/child is an edge type, not a field on the issue.
- `bd ready` lists open issues that nothing is blocking. `ready_issues_view` is that query stored in the database.

---

## Others (from memory, not checked)

- **todo.txt:** one task per line: `x 2026-11-12 (A) 2026-11-01 text +project @context key:value`. No ids, links or history unless you add your own `key:value` tags. pi-do's store is built on this format and adds `piid:`, `pistart:`, `pidesc:`, `piparent:` and `piresult:` tags.
- **Backlog.md:** one Markdown file per task in `backlog/tasks/task-<n> - <title>.md`. YAML frontmatter holds `id`, `title`, `status`, `assignee`, `labels`, `dependencies`, `parent`, `priority` and dates. The body has description, acceptance-criteria checklist and plan sections. Git is the database.
- **Claude Code TodoWrite:** a list held in the session as `{content, status: pending|in_progress|completed, activeForm}`. Nothing is saved after the session ends.

---

## Takeaways for pi-do

- **A fixed, typed record** (Dex) is simple and reads well in a git diff. Storing links on both sides, though, means every link change has to update two tasks.
- **An open-ended map plus a change log** (TaskChampion) gives undo, per-property conflict resolution and adding fields without a schema change.
- **A separate edge table** (Beads) handles many kinds of links and makes "what's ready to work on" a single query, at the cost of needing a database.
- **Hash-based ids** (Beads) and UUIDs (Taskwarrior, pi-do's `piid`) let several agents and branches create tasks without picking the same id.

## Sources
- https://github.com/dcramer/dex (`src/types.ts`, `AGENTS.md`)
- https://deepwiki.com/dcramer/dex
- https://github.com/DanielCarmingham/dexrust
- https://github.com/GothenburgBitFactory/taskchampion (`src/operation.rs`, `src/storage/mod.rs`, `src/storage/sqlite/schema.rs`, `src/task/`)
- https://taskwarrior.org/docs/upgrade-3/
- https://docs.rs/taskchampion
- https://github.com/alacritree/alacritree/issues/410
- https://lwn.net/Articles/969904/
- https://github.com/steveyegge/beads (`internal/types/types.go`, `internal/storage/schema/migrations/`, README)
