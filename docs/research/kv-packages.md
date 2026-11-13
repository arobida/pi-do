# Key-value / embedded storage packages for pi-do

Researched 2026-11-13. Versions and dependencies come from `npm view <pkg> version engines dependencies` (https://www.npmjs.com/package/<pkg>), run that day. The Bun claims marked "tested" come from Bun 1.4.4 on macOS. All other claims cite the package's own docs or source.

## What pi-do does today (see unstorage.md for line refs)

- One JSONL file per list. Saves write a temp file with mode `0o600` and then `renameSync` it into place (`src/tasks.ts:32`).
- A cross-process lock file with `wx` and a 10 s stale timeout (`src/util.ts:7-19`).
- Index files are append-only (`src/store.ts:99`, `:109`).
- `fs.watch` on the folder notices changes from other processes (`src/index.ts:162-169`).
- Zero runtime deps. Files are greppable and diffable.

## Candidates

| Package | Version | Deps / native | Bun | Multi-process safe | File mode | Change events | Sync |
|---|---|---|---|---|---|---|---|
| **bun:sqlite** | built into Bun | none | native | yes, SQLite locking; WAL lets readers run during a write | not settable; new DB is 0644 (tested), needs `chmodSync` | none across processes | none |
| **node:sqlite** | built into Node 22.5+ | none | importable in Bun 1.4.4 (tested: exports `DatabaseSync`) | same as SQLite | same as above | none | `Session` changesets exist (exported) |
| lowdb | 7.0.1 | steno | pure JS | **no**; single-writer design | no option | none | none |
| steno | 4.0.2 | 0 | pure JS | in-process write ordering only | no option | none | none |
| keyv + @keyv/sqlite | 6.1.0 | hookified, **better-sqlite3** (native) | better-sqlite3 is a Node addon; Bun support unverified | SQLite's | no | in-process hooks only | none |
| conf | 16.0.0 | 9 deps (ajv, atomically, semver...) | pure JS | atomic writes; no lock | supports `configFileMode` | `watch: true` fires `onDidChange` on cross-process edits | none |
| lmdb | 3.5.9 | 6 deps + native addon | README claims Node, Bun and Deno support | yes (LMDB is multi-process) | no | none | none |
| level / classic-level | 10.0.0 / 3.0.0 | native LevelDB | addon | **no**; one process holds the LOCK | no | none | none |
| proper-lockfile | 4.1.2 | graceful-fs, retry, signal-exit | pure JS | mkdir-based lock with mtime refresh | n/a | n/a | n/a |
| write-file-atomic | 8.0.0 | signal-exit; engines Node ^22.22 \|\| ^24.15 \|\| >=26 | pure JS | atomic rename, no lock | `mode` option | n/a | n/a |
| @automerge/automerge | 3.5.0 | 0 (WASM) | WASM | CRDT; storage is up to you | n/a | n/a | yes, offline-first, merges |
| yjs | 13.6.33 | lib0 | pure JS | CRDT; storage is up to you | n/a | n/a | yes, offline-first, merges |
| @libsql/client | 0.18.0 | 5 deps incl. native `libsql` | native addon | SQLite | no | none | Turso embedded replicas; needs a server, opt-in `offline: true` local writes |
| @vlcn.io/crsqlite | 0.16.3 | loadable extension | needs an extension loaded into SQLite | SQLite | no | none | CRDT merge of tables (https://github.com/vlcn-io/cr-sqlite#readme) |
| pouchdb | 9.0.0 | 14 deps incl. leveldown (native) | addon | no (LevelDB lock) | no | `changes()` feed | CouchDB replication |

### Notes and sources

- **bun:sqlite.** Bun's docs recommend `PRAGMA journal_mode = WAL` for concurrency and document `Database` options and transactions (https://bun.com/docs/runtime/sqlite). Tested: WAL turns on, and the DB, `-wal` and `-shm` files are created with mode 0644 under the default umask. Each one would need a `chmodSync(…, 0o600)`, and the sidecar files get recreated. SQLite serializes writers with file locks and returns `SQLITE_BUSY` on contention, so you set `PRAGMA busy_timeout` (https://www.sqlite.org/wal.html, section "Concurrency"; https://www.sqlite.org/pragma.html#pragma_busy_timeout). WAL needs shared memory, so it does not work on network filesystems (https://www.sqlite.org/wal.html, "Overview" disadvantages). That matters for a `~/.pi-do` in iCloud or Dropbox: copying a live database can corrupt it. SQLite's "1.2 Backup or restore while a transaction is active" covers background backup tools; it names no specific sync product (https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active). On macOS, Bun uses Apple's SQLite, which keeps the `-wal`/`-shm` files after close (https://bun.com/docs/runtime/sqlite).
- **node:sqlite.** Exposes `DatabaseSync` and `Session`/changesets (https://nodejs.org/api/sqlite.html, "class: Session"). Bun's compatibility page marks `node:sqlite` "Fully implemented" (https://bun.com/docs/runtime/nodejs-compat, "node:sqlite").
- **lowdb.** The README's "Limits" section says it doesn't support Node's cluster module and that every `db.write` serializes and rewrites all of `db.data` (https://github.com/typicode/lowdb#limits, README.md:396-400 in the 7.0.1 tarball). Multi-process locking isn't mentioned. steno advertises "No race conditions (writes are ordered even if they're async)" (steno README.md:16); its ordering is per writer instance, and nothing says it covers other processes. It adds nothing pi-do lacks.
- **keyv.** `@keyv/sqlite` depends on `better-sqlite3` (npm deps above). The Bun SQLite page credits better-sqlite3 for its API but doesn't say whether the addon runs under Bun (**unverified**). It also adds a dependency only to get get/set.
- **conf.** Built for app settings: atomic writes (README.md:47), `configFileMode` (README.md:509) and a `watch` option that "is useful if there are multiple processes changing the same config file" (README.md:494) (https://github.com/sindresorhus/conf#readme). It has no lock. It pulls in 9 deps. pi-do's JSONC comment-preserving edits would be lost, because conf rewrites the JSON.
- **lmdb-js.** The README says it is "designed to scale across multiple processes or threads" and names Bun as supported (README.md:7, :30; https://github.com/kriszyp/lmdb-js#readme). That is a claim; I didn't run it under Bun. It is a native binary store, so the files are not greppable. Overkill for a few hundred tasks.
- **level / classic-level.** The README says the DB takes an exclusive lock, so a second process opening it fails with `LEVEL_LOCKED` (README.md:92; https://github.com/Level/classic-level#readme). That disqualifies it, since pi-do runs several Pi processes.
- **proper-lockfile.** Locks by `mkdir` and keeps the lock alive by refreshing its mtime (README.md:29, :32; https://github.com/moxystudio/node-proper-lockfile#readme). That is a better stale lock than pi-do's fixed 10 s timeout, but it brings 3 deps and an async API. pi-do's `src/util.ts:13` shortcut is fine for interactive use.
- **write-file-atomic.** Temp file plus rename, with `mode`/`chown` options (README.md:18, :23; https://github.com/npm/write-file-atomic#readme). That is what `src/tasks.ts:32` already does in one line, and v8's engines field is narrow.
- **Automerge / Yjs.** CRDT documents that merge concurrent offline edits (https://automerge.org/docs/hello/; https://docs.yjs.dev/). You bring your own storage and transport, and the saved form is binary. They only make sense if real multi-device editing of the same list becomes a goal.
- **libSQL / Turso embedded replicas.** A local SQLite file that syncs with a Turso primary. By default writes "are sent to the remote primary" and "NOT written to the local file first". Local writes need the opt-in `offline: true` option (https://docs.turso.tech/features/embedded-replicas/introduction). It needs a hosted server and a native dep.
- **cr-sqlite.** CRDT tables inside SQLite (https://github.com/vlcn-io/cr-sqlite#readme). You load it as an extension, and on macOS Bun uses Apple's system SQLite, which "doesn't support extensions", so you would have to point Bun at a different SQLite build (https://bun.com/docs/runtime/sqlite, "loadExtension" / "macOS users"). (I removed an earlier "upstream has slowed" claim because I had no source for it.)
- **PouchDB.** CouchDB-style replication with a `changes()` feed (https://pouchdb.com/api.html#changes). It has 14 deps including native leveldown, and LevelDB is single-process. Too heavy.

## Does bun:sqlite (WAL) beat JSONL for multi-process safety?

Only a little, and not enough to be worth it.

- **Today:** the lock file serializes read-modify-write, and rename makes every save atomic. Readers never see a half-written file. The real gaps are small. A crashed holder's lock counts as stale only after 10 s (`src/util.ts:13-14`), but a waiter gives up after about 201 × 25 ms ≈ 5 s and throws `Task file is locked` (`src/util.ts:15-16`). So a save made right after a crash fails; it doesn't wait. A save retried after 10 s takes the lock. A process that takes over the lock after 10 s while the holder is only slow could lose an update, which is unlikely with sub-millisecond saves.
- **SQLite WAL:** you get real transactions, locking that releases when a process dies (a busy writer returns SQLITE_BUSY, which `busy_timeout` retries: https://www.sqlite.org/wal.html section 9, https://www.sqlite.org/pragma.html#pragma_busy_timeout), and per-row updates instead of rewriting the whole file. But for pi-do's data size (a few KB per list), whole-file rewrites cost nothing.
- **What you lose:** greppable, diffable, hand-editable files. The 0o600 privacy would need chmod on three files. You also lose safety in a synced folder, which is the sync path unstorage.md recommends: SQLite lists "backup or restore while a transaction is active" as a cause of corruption, and a sync client copying a live DB is the same risk. The page doesn't name Dropbox or iCloud. And you would need a cross-process change signal. `fs.watch` on a `-wal` file is noisy, so you would poll `PRAGMA data_version` (https://www.sqlite.org/pragma.html#pragma_data_version).
- **Verdict:** keep JSONL.

## Ranked recommendation

1. **Adopt nothing now.** The current code already does what write-file-atomic and steno do, and close to what proper-lockfile does, with zero deps. It is greppable and safe to sync as a folder.
2. **If the lock ever bites** (reports of lost updates or 10 s waits), fix it in place rather than adding a dep. Refresh the lock's mtime during long holds, or take a lock via `mkdirSync` the way proper-lockfile does. Choose proper-lockfile only if you accept 3 deps.
3. **If a real database is ever needed** (thousands of tasks, queries, history), use **bun:sqlite** with WAL, `busy_timeout` and chmod 0o600. It is built in, so it adds zero deps. Keep a JSONL export for grep and git. Do not put the DB in a file-synced folder.
4. **Cross-machine sync, offline-first:** stay with a synced or git-tracked `~/.pi-do` of JSONL files. Line-oriented files merge in git, and the conflicts stay human-readable. If concurrent multi-device edits become a real requirement, **Automerge** is the best fit: zero npm deps, WASM, and offline merging by design. Store one doc per list next to a JSONL projection. Expect significant design work.
5. **Skip:** lowdb/steno (nothing new), keyv (adds native better-sqlite3 when bun:sqlite is built in), conf (9 deps, rewrites JSON so JSONC comments are lost), level/classic-level and PouchDB (single-process LevelDB), lmdb (native, binary files, overkill), libSQL/Turso (needs a server), cr-sqlite (Apple SQLite used by Bun on macOS cannot load extensions), Yjs (fine, but Automerge's persistence/merge model fits documents-on-disk better and it has zero deps).

## Verification (2026-11-13)

README claims were checked against the npm tarballs (`npm pack`), and the line numbers point into each package's `README.md`. Web docs (Bun, sqlite.org, nodejs.org, Turso, PouchDB, Automerge, Yjs, cr-sqlite README) were fetched and the quoted text was confirmed.

**Unverified:** whether better-sqlite3 (and so @keyv/sqlite) runs under Bun; lmdb, Automerge and libSQL under Bun (lmdb's README claims Bun support); that the PouchDB, Automerge and Yjs dependency counts behave as described at runtime. I did not benchmark contention.
