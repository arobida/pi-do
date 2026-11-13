# keyv (file/SQLite adapters) and LokiJS for pi-do

Researched 2026-11-13. Versions from `npm view`; repo facts from `gh api repos/...`. "tested" = run under Bun 1.4.4 / macOS arm64 in a scratch dir (workers: 4 concurrent Bun processes x 50 writes each, 200 expected). Otherwise "docs-only" / source-read.

## What pi-do does today
- Save = temp file (mode `0o600`) + `renameSync` (`src/tasks.ts:32`); read-modify-write is serialized by `withLock` (`src/util.ts:6-20`, `wx` lock file, 10 s stale); `fs.watch` for cross-process events (`src/index.ts:152-169`); JSONL, one record per line, greppable. Zero runtime deps.
- Prior notes: `kv-packages.md` left "does @keyv/sqlite / better-sqlite3 run under Bun" unverified; `jsonl-packages.md` skipped keyv file adapters and LokiJS.

## Comparison

| | keyv 6.1.0 + @keyv/sqlite 6.1.0 | keyv-file 5.3.5 | lokijs 1.5.12 | @lokidb/loki + fs-storage 2.1.0 |
|---|---|---|---|---|
| Last publish | 2026-10-06 | 2026-06-26 | 2024-05-06 | 2022-04-06 |
| Repo | active (push 2026-11-11, 3 issues) | push 2026-08-14, 0 issues | not archived, last push 2023-06, 35 issues | not archived, last push 2023-08 |
| Deps / size | keyv: hookified (357 kB). @keyv/sqlite: hookified + better-sqlite3 (27.5 MB native) | @keyv/serialize, tslib (23 kB) | 0 deps, 3.1 MB unpacked | 1 dep, 0.7 + 0.14 MB |
| Bun | **tested: works.** 6.1.0 auto-picks `bun:sqlite` first, better-sqlite3 second (`dist/index.mjs:46`). better-sqlite3 13 also loads in Bun (tested) but is not needed | tested: works | tested: works | not tested (stale) |
| Concurrent writers (distinct keys, 4x50) | **200/200 kept** (with `busyTimeout: 5000`) | **51/200** | **102/200** | not tested |
| Default config concurrency | 3 of 4 workers crashed with `SQLITE_BUSY database is locked` in `ensureSchema` (no busy timeout by default; tested) | n/a | n/a | n/a |
| Read-modify-write on one key (list in one key) | 50/200 kept: keyv has no transaction/CAS, so you still need pi-do's lock (tested) | 50/200 (tested) | 94/200 (tested) | n/a |
| File mode | 0644 (tested; needs chmod; also -wal/-shm) | 0644 (tested) | 0644 (tested) | docs-only: same fs writes |
| Atomic save | SQLite transactions | **no**: `fsp.writeFile` in place (`lib/index.js:232`) | yes-ish: writes `name~` then renames (`lokijs.js` ~2437-2442); no mode option | docs-only |
| Cross-process events | none | none (`watch` count 0 in `lib/index.js`) | none (0 `watch` hits in `lokijs.js`) | none known |
| Format | SQLite binary, not greppable | one JSON blob with values double-encoded: `{"cache":[["a",{"value":"{\"value\":{\"n\":1}}"}]],...}` (tested) | one JSON blob with `$loki`/`meta` per doc; rewritten whole (tested) | same as Loki |

## Per-candidate notes
- **keyv core.** It is a get/set API over a pluggable store; it brings no file store itself. No locking, transactions, change feed or file-mode control. The `Keyv` wrapper adds TTL/namespace/hooks that pi-do doesn't use.
- **@keyv/sqlite.** Answers the open question: it runs under Bun, because 6.x ships a `bun:sqlite` driver (`dist/bun-sqlite-driver-*.mjs`), so better-sqlite3 (27 MB, native) is installed but unused under Bun (tested; install log shows it is a hard dependency). It is the only candidate that lost zero writes, and only after setting `busyTimeout`; default options crash under contention. Same drawbacks already recorded in `kv-packages.md` for bun:sqlite (0644 files, sidecar files, binary, sync-folder risk), plus 357 kB of keyv. Using `bun:sqlite` directly gives the same result without keyv or better-sqlite3.
- **keyv-file.** Loads the file into memory at construction and writes the whole map back in place with a delayed `writeFile`; it never re-reads, so each process overwrites the others (51/200 kept, tested). Its `separatedFile`/lock option throws "There is another process using this file" for the second process rather than sharing (`lib/index.js:38,75-87`, docs-only reading). Not atomic, not multi-process, not greppable. Worst fit.
- **LokiJS.** Pure JS, zero deps, in-memory DB with indexes/queries; its `LokiFsAdapter` writes the whole DB as one JSON file (temp `~` + rename). The default setup is single-process: each process holds its own in-memory copy, and `loadDatabase` before each write (my test) still lost 98/200 because there is no lock (tested). With pi-do's `withLock` around load+save it would be correct, but then it adds nothing that the lock + rename don't already provide. No file mode option, no change events, one-blob format loses per-line grep and diff. Upstream is quiet since 2023-06 (35 open issues); the maintained-fork `@lokidb/*` last published 2022.

## Ranked verdict
1. **Adopt nothing.** `withLock` + temp-file/rename + `0o600` + `fs.watch` + JSONL already beats all four on atomicity, mode, events and greppability.
2. If a database is ever needed: `bun:sqlite` directly (no deps), with `PRAGMA busy_timeout`, WAL and `chmodSync`; see `kv-packages.md`.
3. @keyv/sqlite: works on Bun (now verified) but adds 27 MB of unused native dep for a get/set API.
4. LokiJS: only worth it with in-memory querying needs; still needs the existing lock.
5. keyv-file: reject (lost 149/200 writes).

## Not checked
- @lokidb/* under Bun; LokiJS `LokiFsStructuredAdapter` (append-style partitioned format; read, not run); keyv-file `separatedFile` mode behaviour; crash-mid-write atomicity (kill -9); `fs.watch` against sqlite sidecar files; Node runtime (pi may run extensions under another runtime than Bun).
- Scratch tests: `/private/tmp/claude-501/-Users-arobida-Dev-Projects-pi-do/68804fd1-bc80-4bc2-91fa-88d16875c41f/scratchpad/keyv-loki-test/` (`w.mjs` read-modify-write, `w2.mjs` distinct keys, `count.mjs`). Counts are single runs; loss numbers vary run to run.
