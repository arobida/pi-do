# Plan: improvements from the competitor-strengths review

Sources: `.agents/ideas/competitor-strengths.md` and `.agents/research/competitor-verification.md`. Written 2026-11-13. Tracked as [Competitor-strengths plan](pido://79114510-f981-49f5-9929-aa15d25479c9/8c27d83e-6113-4b55-98e0-116be1a33547).

## How the work runs

- Each task below goes to a Sonnet subagent with low thinking.
- After each task, I review the diff and run `bun test` and `bunx tsc --noEmit` before starting the next one.
- Every task adds its test to the existing file under `test/` that fits it best.
- Commit with `wt step commit` after each task passes.

## Tasks

### [T1](pido://79114510-f981-49f5-9929-aa15d25479c9/e8fe4d4e-ff9d-43fd-a1a5-2b9f4be4e7a9). Check `parent` on put and import, and reject cycles

- **Where:** `src/tasks.ts`.
- **Why:** today only `create` checks that a parent exists (`src/tasks.ts:68`). Sync (`put`) and import can write a dangling parent.
- **Change:** add one helper, `checkParent(items, id, parent)`. It throws when the parent id is missing or when the parent is the task itself or one of its descendants. Call it from `create`, from `put`, and once per task after import has parsed all its lines (so a parent defined later in the same file still passes).
- **Test:** a missing parent is rejected on put and on import, and a put that makes a cycle (A→B→A) is rejected.

### [T2](pido://79114510-f981-49f5-9929-aa15d25479c9/b2fc6b6d-b7ae-4d90-8713-312b3e623769). Lock: decide staleness by whether the holder is alive, not by age

- **Where:** `src/util.ts:7-21`.
- **Why:** the 10s mtime rule can break a lock that a slow sync still holds.
- **Change:** read the pid written in the lock file. Remove the lock only if `process.kill(pid, 0)` throws `ESRCH`. Remove the mtime rule. Keep the wait limit, and make the error message name the pid holding the lock.
- **Test:** a lock file holding a dead pid is taken over. A lock file holding the live `process.pid` makes the call time out. Shorten the wait in the test if needed.

### [T3](pido://79114510-f981-49f5-9929-aa15d25479c9/1b340b69-4c7b-4fbe-9b88-0aacbc307b0c). Claims released by events (`claimed_by`)

- **Where:** `src/todo.ts` (`Task`, `optional`, `order`), `src/tasks.ts` (start and complete), `src/index.ts` (pass the claimer, release claims on `session_shutdown` at line 174).
- **Change:**
  - Add the optional field `claimed_by: "<sessionId>:<pid>"`.
  - `start --claim <value>` refuses a task claimed by another live claimer (pid alive and a different value) unless `--force` is passed.
  - `complete` clears `claimed_by`.
  - A new `release --claim <value>` action clears every claim with that value. `session_shutdown` calls it.
  - Put the pid-liveness check from T2 in one shared helper in `src/util.ts`.
- **Sync:** leave `claimed_by` out of the synced fields. `src/adapters/sync.ts:24` doesn't list it, and `put` merges records partially, so the claim survives a sync. A test should confirm this.
- **Test:**
  - A second claimer is refused, and `--force` overrides that.
  - A claim by a dead pid is ignored.
  - `complete` clears the claim, and `release` clears only the matching claims.
- **Depends on:** [T2](pido://79114510-f981-49f5-9929-aa15d25479c9/b2fc6b6d-b7ae-4d90-8713-312b3e623769), for the shared helper.

### [T4](pido://79114510-f981-49f5-9929-aa15d25479c9/3b06d5be-34ed-46f8-95e5-8b1a9dd352a4). Blockers and a "ready" query

- **Where:** `src/todo.ts`, `src/tasks.ts`, `src/index.ts` (the tool's action list and the panel).
- **Change:**
  - Add the optional field `blocked_by: string[]` on the task that waits. Storing it on that side means the ready check reads only the task itself.
  - `toTask` checks that `blocked_by` is an array of strings. All other optional fields are strings, so this needs its own check.
  - `create --blocked-by <id>` and `edit --blocked-by <id>` check that the id exists, using T1's pattern.
  - A new `ready` action lists tasks that are open, have no live claim, and whose blockers are all completed or missing. Treat a missing blocker as done, because the blocker may have been deleted.
  - Add `ready` to the `todo_task` tool's actions.
- **Panel:** leave it unchanged for now. The agent uses `ready`. Adding a fourth panel view is a separate decision.
- **Test:** a blocked task isn't ready, then becomes ready once its blocker is completed. A claimed task isn't ready.
- **Depends on:** [T3](pido://79114510-f981-49f5-9929-aa15d25479c9/1b340b69-4c7b-4fbe-9b88-0aacbc307b0c), because both edit the same lines in `toTask` and `order`, and `ready` uses claims.

### [T5](pido://79114510-f981-49f5-9929-aa15d25479c9/9865fa07-7fa3-4f3b-80a7-75a0c1d937f3). `pido://` Markdown links

- **Where:** `src/store.ts` (registry lookup), `src/tasks.ts` (a `link` action), `src/index.ts` (tool action).
- **Format:** `[name](pido://<project-id>/<task-id>)`. The project id is the stable UUID in `config.json`, so the link survives renames and moves. This plan already uses them.
- **Change:**
  - `link <task-id>` prints the Markdown link for a task, so agents never build one by hand.
  - `resolve <pido-url>` looks up the project id in `~/.pi-do/projects/projects.jsonl`, opens that project's store, and prints the task (name, state, result). Unknown project or task: a clear error, not a crash. Temp-scope projects can't be resolved, and the error says so.
  - Add `link` and `resolve` to the `todo_task` tool's actions.
- **Not in scope:** scanning Markdown files for links or rewriting them. Resolve on demand only.
- **Test:** `link` then `resolve` round-trips; an unknown project id and an unknown task id each give their own error.
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
