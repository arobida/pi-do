# Competitor claim check

Checks the tool claims in `docs/ideas/competitor-strengths.md` against primary sources.
Researched 2026-11-13 from shallow clones of each repo's default branch: beads `526c1c8`, dex `3f55b2a`, taskchampion `b10eeae`, taskwarrior `c564bc3`, todo.txt `1d90c08`, Backlog.md `52b4ea3`. Links point at `main`, so line numbers can drift.

## Verdicts

| Claim | Verdict | Source |
|---|---|---|
| Beads: hash ids | ✅ Confirmed | `GenerateHashID` hashes prefix, title, description, created time and workspace with sha256 ([internal/types/id_generator.go#L29](https://github.com/steveyegge/beads/blob/main/internal/types/id_generator.go#L29)). The README advertises `bd-a1b2` ([README.md#L64](https://github.com/steveyegge/beads/blob/main/README.md#L64)). |
| Beads: `bd ready` | ✅ Confirmed | "List tasks with no open blockers" ([README.md#L73](https://github.com/steveyegge/beads/blob/main/README.md#L73)). |
| Beads: blocking dependencies, 19 edge types | ✅ Confirmed | There are 19 `DependencyType` constants, starting with `DepBlocks` and `DepParentChild` ([internal/types/types.go#L1473](https://github.com/steveyegge/beads/blob/main/internal/types/types.go#L1473)). |
| Beads: DeferUntil | ✅ Confirmed | `DeferUntil *time.Time // Hide from bd ready until this time` ([types.go#L133](https://github.com/steveyegge/beads/blob/main/internal/types/types.go#L133)). A past `defer_until` flips the task back to `open` ([internal/storage/issueops/wake_defers.go#L37](https://github.com/steveyegge/beads/blob/main/internal/storage/issueops/wake_defers.go#L37)). |
| Beads: LeaseExpiresAt / claims | ✅ Confirmed | `LeaseExpiresAt` is "when the current claim's lease expires" ([types.go#L63](https://github.com/steveyegge/beads/blob/main/internal/types/types.go#L63)). A heartbeater renews it ([internal/issueops/heartbeater.go#L104](https://github.com/steveyegge/beads/blob/main/internal/issueops/heartbeater.go#L104)). |
| Beads: archives finished tasks (#14) | ⚠️ Partly | Beads doesn't archive. It does semantic "memory decay": it summarizes old closed tasks in place ([README.md#L65](https://github.com/steveyegge/beads/blob/main/README.md#L65)) and records `CompactionLevel`/`CompactedAt` ([types.go#L145](https://github.com/steveyegge/beads/blob/main/internal/types/types.go#L145)). Separately, `bd compact` squashes old Dolt commits ([cmd/bd/compact_dolt.go#L19](https://github.com/steveyegge/beads/blob/main/cmd/bd/compact_dolt.go#L19)). Credit #14 to Dex only. |
| Dex: JSONL storage | ✅ Confirmed | `tasks.jsonl` ([src/core/storage/jsonl-storage.ts#L34](https://github.com/dcramer/dex/blob/main/src/core/storage/jsonl-storage.ts#L34)). |
| Dex: Zod schema | ✅ Confirmed | `TaskSchemaBase = z.object(...)` ([src/types.ts#L66](https://github.com/dcramer/dex/blob/main/src/types.ts#L66)). |
| Dex: `blocks`/`blockedBy` stored on both sides | ✅ Confirmed | Both fields, plus `children` as the "inverse of parent_id" ([src/types.ts#L95-L97](https://github.com/dcramer/dex/blob/main/src/types.ts#L95-L97)). |
| Dex: `result`, `started_at` | ✅ Confirmed | [src/types.ts#L84](https://github.com/dcramer/dex/blob/main/src/types.ts#L84), [#L92](https://github.com/dcramer/dex/blob/main/src/types.ts#L92). |
| Dex: archive file | ✅ Confirmed | Auto-archive moves eligible tasks, chosen by age and count, to `archive.jsonl` and logs each move to `archive.log` ([src/core/auto-archive.ts#L80-L95](https://github.com/dcramer/dex/blob/main/src/core/auto-archive.ts#L80-L95)). |
| Dex ids | ℹ️ Note | Dex ids aren't UUIDs. They're 8-char base36 nanoids ([src/core/task-service.ts#L42](https://github.com/dcramer/dex/blob/main/src/core/task-service.ts#L42)). That fits the doc's #3, which credits only Beads and Taskwarrior. |
| Taskwarrior/TC: UUIDs | ✅ Confirmed | `Uuid::new_v4` ([taskchampion src/replica.rs#L311](https://github.com/GothenburgBitFactory/taskchampion/blob/main/src/replica.rs#L311)). |
| Taskwarrior/TC: unknown attributes/UDAs kept | ✅ Confirmed | `get_udas`/`get_legacy_udas` ([src/task/task.rs#L258](https://github.com/GothenburgBitFactory/taskchampion/blob/main/src/task/task.rs#L258)). Taskwarrior keeps and reports "orphan UDAs" ([doc/man/task.1.in#L824](https://github.com/GothenburgBitFactory/taskwarrior/blob/develop/doc/man/task.1.in#L824)). |
| Taskwarrior/TC: `wait` | ✅ Confirmed | `get_wait`, `is_waiting` ([src/task/task.rs#L144-L154](https://github.com/GothenburgBitFactory/taskchampion/blob/main/src/task/task.rs#L144)). |
| Taskwarrior: urgency | ✅ Confirmed | Coefficients such as `urgency.due.coefficient=12.0` ([taskwarrior src/Context.cpp#L187](https://github.com/GothenburgBitFactory/taskwarrior/blob/develop/src/Context.cpp#L187)). |
| TC: operation-log sync and conflict resolution | ✅ Confirmed, with detail | Sync uses operational transformation, and update timestamps resolve conflicts ([docs/src/sync-model.md#L9](https://github.com/GothenburgBitFactory/taskchampion/blob/main/docs/src/sync-model.md#L9), [#L53](https://github.com/GothenburgBitFactory/taskchampion/blob/main/docs/src/sync-model.md#L53)). It's more than an undo log. |
| todo.txt: `key:value` tags | ✅ Confirmed | "Developers should use the format `key:value`" ([README.md#L195](https://github.com/todotxt/todo.txt/blob/master/README.md#L195)). |
| todo.txt: `done.txt` | ❌ Not in spec | The format spec never mentions `done.txt`. It belongs to the todo.txt-cli tool. |
| todo.txt: `t:` threshold | ❌ Not in spec | `t:` is a client add-on convention, not part of the spec. The only example key the spec gives is `due:`. That's fine for #9, which treats `t:` as an unknown tag. |
| Backlog.md: one Markdown file per task | ✅ Confirmed | Task ledger is in [backlog/tasks](https://github.com/MrLesk/Backlog.md/tree/main/backlog/tasks) ([README.md#L49](https://github.com/MrLesk/Backlog.md/blob/main/README.md#L49)). |
| Backlog.md: acceptance criteria | ✅ Confirmed | It also has a reusable Definition of Done checklist ([README.md#L59](https://github.com/MrLesk/Backlog.md/blob/main/README.md#L59)). |

## Strengths the doc missed

1. **Parent cycle and depth checks (Dex).** When a parent changes, Dex rejects a parent that is a descendant ("would create a cycle") and caps the depth ([src/core/task-service.ts#L276](https://github.com/dcramer/dex/blob/main/src/core/task-service.ts#L276), [#L381](https://github.com/dcramer/dex/blob/main/src/core/task-service.ts#L381)). pi-do's #4 gap (checking `parent` on `put`/import) should include the cycle check too.
2. **Defaults for missing fields on read (Dex).** Old records get `blockedBy`/`blocks`/`started_at` filled in, with no migration step ([src/types.ts#L124-L129](https://github.com/dcramer/dex/blob/main/src/types.ts#L124)). If pi-do adds optional fields, `toTask` can default them the same way.
3. **Deferral that wakes itself (Beads).** A past `defer_until` reopens the task. A defer with no date is an indefinite icebox ([wake_defers.go#L37-L40](https://github.com/steveyegge/beads/blob/main/internal/storage/issueops/wake_defers.go#L37)). If pi-do adds #13, the read-time filter `defer_until > now` needs no wake step at all.
4. **Lease renewal by heartbeat (Beads).** The claim holder renews `LeaseExpiresAt` ([heartbeater.go#L104](https://github.com/steveyegge/beads/blob/main/internal/issueops/heartbeater.go#L104)). This is the same fix #12 needs for `withLock`: refresh the lock while it's held.
5. **Lenient reading of incomplete records (TaskChampion).** A completed task with no `end` is read as "completed at an unknown time" instead of being rejected ([docs/src/tasks.md#L10](https://github.com/GothenburgBitFactory/taskchampion/blob/main/docs/src/tasks.md#L10)). pi-do's import could do the same for `completed` with no `completed_date`.
