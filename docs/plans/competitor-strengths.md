# Plan: improvements from the competitor-strengths review

Sources: `docs/ideas/competitor-strengths.md` and `docs/research/competitor-verification.md`. Written 2026-11-13. Tracked as [Competitor-strengths plan](pido://79114510-f981-49f5-9929-aa15d25479c9/8c27d83e-6113-4b55-98e0-116be1a33547).

## How the work runs

- Each task below goes to a Sonnet subagent with low thinking.
- After each task, I review the diff and run `bun test` and `bunx tsc --noEmit` before starting the next one.
- Every task adds its test to the existing file under `test/` that fits it best.
- Commit with `wt step commit` after each task passes.

## Tasks

### [T1](pido://79114510-f981-49f5-9929-aa15d25479c9/e8fe4d4e-ff9d-43fd-a1a5-2b9f4be4e7a9). Check `parent` on put and import, and reject cycles

- **Where:** `src/tasks.ts`, `src/adapters/sync.ts`.
- **Why:** today only `create` checks that a parent exists (`src/tasks.ts:68`). Sync (`put`) and import can write a dangling parent.
- **Change:**
  - Add one helper, `checkParent(items, id, parent)`. It throws a `ParentError` (a distinct class, so callers can tell it apart) when the parent id is missing, or when the parent is the task itself or one of its descendants.
  - Call it from `create`, from `put`, and once per task after import has parsed all its lines (so a parent defined later in the same file still passes).
- **Put checks the merged record.** `put` merges partially, so a put without `parent` keeps the old one. Run the check on the merged task, not on the input.
- **Sync must not abort.** Sync calls `put` for every task, and remote cycles can happen (see the `n < 50` cap in `src/adapters/sync.ts:42`). One throwing `put` would stop the whole sync partway.
  - On a `ParentError`, sync retries that task with `parent: ""`. That is the existing way to clear a field, so it also clears a bad parent the record already had. Leaving `parent` out wouldn't work, because the merge would bring the bad value back.
  - Build `link.base` from the record that was actually saved (re-read after the put), not from `{ ...lv, ...pull }`. Then the baseline never describes a parent that was never stored.
- **Test:**
  - A missing parent is rejected on put and on import, and a cycle (A→B→A) is rejected on put.
  - A sync where the remote tasks form a cycle still finishes, keeps the other tasks, and stores no parent for the task that was rejected.
  - A linked task whose stored parent is already dangling still takes an unrelated remote update, and its parent gets cleared.

### [T2](pido://79114510-f981-49f5-9929-aa15d25479c9/b2fc6b6d-b7ae-4d90-8713-312b3e623769). Lock: decide staleness by whether the holder is alive, not by age

- **Where:** `src/util.ts:7-21`.
- **Why:** the 10s mtime rule can break a lock that a slow sync still holds.
- **Change:**
  - Write `"<pid>:<random token>"` to the lock. On exit, unlink only if the file still holds our token, so we never delete someone else's lock.
  - Liveness: `process.kill(pid, 0)`. `ESRCH` means dead, and `EPERM` means alive.
  - **Takeover without a double holder:** a waiter that sees a dead pid renames the lock to a unique `lock.<uuid>.stale`, which is atomic, so only one waiter wins. The winner reads the renamed file. If it isn't the content the waiter saw as dead, a new holder took the lock in between. The waiter then puts the file back with `linkSync(stale, lock)`, which fails if the path exists, so it never overwrites. Either way it deletes the `.stale` file and loops.
  - **Empty lock:** the file is created before the pid is written, so it can be read empty for a moment. Treat an empty or malformed lock as alive unless its mtime is more than 5s old, then as stale. This is the only place mtime is still used.
  - Remove the 10s mtime rule for locks that hold a pid. Keep the wait limit.
  - The timeout error names the lock path and the holder pid, and says to delete the file if that pid isn't a pi-do process. That is the manual fix when a pid gets reused.
- **Caveat:** pids only mean something on one machine. The store is local today (`~/.pi-do`), so that's fine. A reused pid makes a stale lock look live until someone deletes it by hand. The error message tells the user how.
- **Test:**
  - A lock with a dead pid is taken over.
  - A lock with the live `process.pid` makes the call time out, with the pid in the message.
  - An empty lock older than 5s is taken over.
  - Two waiters racing on a dead-pid lock: both finish, never at the same time. Have each one append to a shared array inside `fn` and check that the entries don't interleave.
  - Shorten the wait in the tests if needed.

### [T3](pido://79114510-f981-49f5-9929-aa15d25479c9/1b340b69-4c7b-4fbe-9b88-0aacbc307b0c). Claims released by events (`claimed_by`)

- **Where:** `src/todo.ts` (`Task`, `optional`, `order`), `src/tasks.ts` (start and complete), `src/index.ts` (pass the claimer, release claims on `session_shutdown` at line 174), `src/adapters/sync.ts` (create payload).
- **Change:**
  - Add the optional field `claimed_by: "<sessionId>:<pid>"`.
  - **Claims are enforced, not advisory.** `start --claim <value>` and `complete --claim <value>` both refuse a task claimed by another live claimer (pid alive and a different value) unless `--force` is passed. The tool always passes this session's claim.
  - `complete` clears `claimed_by`.
  - A new `release --claim <value>` action clears every claim with that value. `session_shutdown` calls it.
  - Move the pid-liveness check from T2 into one shared helper in `src/util.ts`.
- **Crash:** `session_shutdown` doesn't run when pi crashes. A dead pid makes the claim count as free, so that case needs no cleanup. A reused pid keeps it looking live until `--force` or `release`. That limit is accepted and goes in a `shortcut:` comment.
- **Sync:** `claimed_by` stays local.
  - Leaving it out of `fields` (`src/adapters/sync.ts:24`) only covers updates. `adapter.create` at `src/adapters/sync.ts:45` gets `{ ...t }`, which includes every field.
  - Fix: pass `adapter.create` only the synced `fields`, plus `id` and the mapped parent. That also covers T4's `blocked_by`.
- **Test:**
  - A second claimer is refused on `start` and on `complete`, and `--force` overrides both.
  - A claim by a dead pid is ignored.
  - `complete` clears the claim, and `release` clears only the matching claims.
  - A claim survives a sync pull.
  - A fake adapter's `create` never receives `claimed_by`.
- **Depends on:** [T2](pido://79114510-f981-49f5-9929-aa15d25479c9/b2fc6b6d-b7ae-4d90-8713-312b3e623769), for the shared helper.

### [T4](pido://79114510-f981-49f5-9929-aa15d25479c9/3b06d5be-34ed-46f8-95e5-8b1a9dd352a4). Blockers and a "ready" query

- **Where:** `src/todo.ts`, `src/tasks.ts`, `src/index.ts` (the tool's action list and its edit validation).
- **Change:**
  - Add the optional field `blocked_by: string[]` on the task that waits. Storing it on that side means the ready check reads only the task itself.
  - `toTask` checks that `blocked_by` is an array of strings. All other optional fields are strings, so this needs its own check.
  - **Set and clear:** `--blocked-by "<id>,<id>"` takes a comma-separated list and *replaces* the whole list. `--blocked-by ""` clears it. The options parser keeps one string per option, so this fits it without changes.
  - **Validation**, on `create` and `edit`:
    - Every id must exist.
    - A task can't block itself.
    - No cycle is allowed: walk `blocked_by` from each new blocker, and reject if the walk reaches the task being edited.
    - Reuse T1's walk-and-throw pattern.
  - The `todo_task` tool accepts an `edit` that only sets `blocked_by`. Today it rejects an edit with no name or description (`src/index.ts:100-112`).
  - A new `ready` action lists tasks that are open, have no live claim, and whose blockers are all completed or missing. A missing blocker counts as done, because it may have been deleted.
  - Add `ready` to the `todo_task` tool's actions.
- **Panel:** leave it unchanged for now. The agent uses `ready`. Adding a fourth panel view is a separate decision.
- **Sync:** `blocked_by` stays local. T3's fix to the create payload keeps it out of `adapter.create`, and the partial `put` keeps it through a pull.
- **Test:**
  - A blocked task isn't ready, then becomes ready once its blocker is completed. A claimed task isn't ready.
  - Self-blocking and mutual blocking (A↔B) are rejected.
  - Multiple blockers work, and `--blocked-by ""` clears them.
- **Depends on:** [T3](pido://79114510-f981-49f5-9929-aa15d25479c9/1b340b69-4c7b-4fbe-9b88-0aacbc307b0c), because both edit the same lines in `toTask` and `order`, and `ready` uses claims.

### [T5](pido://79114510-f981-49f5-9929-aa15d25479c9/9865fa07-7fa3-4f3b-80a7-75a0c1d937f3). `pido://` Markdown links

- **Where:** `src/store.ts` (registry lookup and path refresh), `src/tasks.ts` (a `link` action), `src/index.ts` (tool action).
- **Format:** `[name](pido://<project-id>/<task-id>)`. The project id is the stable UUID in `config.json`. This plan already uses them.
- **Moves:** today the registry saves a project's path only the first time it sees the project (`src/store.ts:73-78`, `:99-103`), so a moved project would resolve to the old place.
  - Fix: when a project is opened and its registered path differs, update the path. Last opened wins.
  - So a link works after a move once pi has been opened in the new place. Until then, `resolve` fails with a clear error naming the old path. It never reads a stale copy silently: if the old path still exists, `resolve` checks that its `config.json` has the same id.
- **Change:**
  - `link <task-id>` prints the Markdown link for a task, so agents never build one by hand.
  - `resolve <pido-url>` looks up the project id in `~/.pi-do/projects/projects.jsonl`, opens that project's store, and prints the task (name, state, result).
  - An unknown project or an unknown task gives a clear error, not a crash.
  - **Not linkable:** temp-scope stores and explicit-file stores (`PI_DO_FILE` or `config.file`, `src/store.ts:84`). Neither is registered, so `link` refuses them with an error saying why.
  - Add `link` and `resolve` to the `todo_task` tool's actions.
- **Not in scope:** scanning Markdown files for links or rewriting them. Resolve on demand only.
- **Test:**
  - `link` then `resolve` round-trips.
  - An unknown project id and an unknown task id each give their own error.
  - Resolving after moving the project directory and reopening it works.
  - `link` on an explicit-file store is refused.
- **Depends on:** nothing; can run alongside T1 and T2.

## Not doing (pushed back)

- **Archive to `done.jsonl` (#14).** Every reader of completed tasks would need to read a second file: the panel, export, sync, the `parent` walk, `ready`, and `resolve`. Do it only when the store gets big enough to be slow. That point is still unmeasured, so measure first.
- **Deferred tasks (#13).** Optional. If they're added later, use a read-time filter `defer_until > today`; it needs no wake step.
- **Defaults for missing fields, and lenient import of a completed task with no completion date.** All new fields are optional, so there's nothing to default.

## Order

T1, T2 and T5 are independent and can run in parallel. T3 comes after T2, and T4 after T3.

## Checked decisions

- **`blocked_by` on the waiting task:** kept. Beads and Dex both store the dependency on the dependent task, and `ready` then reads one task at a time.
- **Panel unchanged:** kept. `ready` is an agent query; a fourth view can come later if wanted.
