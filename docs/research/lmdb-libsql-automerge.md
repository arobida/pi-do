# lmdb, libSQL and Automerge for pi-do

Researched 2026-11-13 on Bun 1.4.4, macOS arm64, umask 022. This follows up `kv-packages.md`, which left these three unverified under Bun. "Tested" means I ran it in a scratch dir outside the repo. Everything else cites the package's README or source from the installed tarball.

Today pi-do keeps one JSONL file per list, guards writes with a `wx` lock file (`src/util.ts:7-19`), writes a temp file and renames it into place, uses mode `0o600` (`src/store.ts:106`), and watches the folder with `fs.watch` (`src/index.ts:152-169`). It has zero runtime deps.

## Summary

| | lmdb 3.5.9 | @libsql/client 0.18.0 | @automerge/automerge 3.5.0 (+ repo 2.6.0-alpha.3) |
|---|---|---|---|
| Works under Bun | **yes (tested)** | **yes, local file (tested)**; replica open fails with no server (tested) | **yes, WASM loads (tested)** |
| Deps / size | 6 deps + 1.4 MB native prebuild | 5 deps + 7.5 MB native `@libsql/darwin-arm64` | core: 0 deps, 45 MB unpacked (WASM for several targets); repo: 8 deps, 3.2 MB |
| Multi-process | **yes (tested)**: 2×500 read-modify-write txns, final 1000 | **yes (tested)**: 2×300 increments plus 300 more, final 900 | raw file: **no (tested, corrupted)**; repo + nodefs: **yes (tested)**, 201/201 keys |
| File mode | 0644 (tested); no mode option in the README | 0644 (tested); no option | raw file: you write it, `0o600` works (tested); repo files 0644 (tested) |
| Change notification | in-process `beforecommit` only (README.md:595-597) | none | in-process handle events; cross-process none without a network adapter |
| Sync | none | Turso embedded replicas; needs a server even to open | CRDT merge, offline-first; a peer or sync server is needed to exchange |
| Files greppable | no (binary `data.mdb`, `lock.mdb`) | no (SQLite) | no (binary chunks) |

Combined `node_modules` for all of them: 75 MB, 33 packages.

## lmdb (lmdb-js)

- **Bun.** The README says it supports "NodeJS, Bun, and Deno" (README.md:7) and uses Node-API for Bun (README.md:30). Tested: `open()`, `put`, `get` and `transaction` all work.
- **Multi-process.** "designed to scale across multiple processes" (README.md:7, :415). Robust mutexes are on by default so a crashed process doesn't hang the others (README.md:636). Tested: two concurrent `bun` processes each ran 500 `db.transaction` read-modify-write increments on one key. The final value was 1000, so no updates were lost.
- **Files.** It creates a directory holding `data.mdb` (278 KB after the test) and `lock.mdb`, both 0644. The README has no file-mode option. `noSubdir` only turns the path into a file instead of a directory (README.md:556). You would need `chmod` after open. The values are msgpack (`msgpackr` dep), not text.
- **Change events.** The only event is `beforecommit`, which is in-process (README.md:595-597). Another process's writes become visible only when the read txn resets on the next event turn or after `resetReadTxn` (README.md:411). So pi-do would still need `fs.watch` on `data.mdb`.
- **Sync.** None.
- **pi-do changes.** Replace `readJsonl`/`withLock`/temp+rename in `src/tasks.ts` and `src/util.ts` with `db.get`/`db.transaction`. Rewrite `migrate`/rename in `src/store.ts` to work on DB directories. Change watch targets. Write a JSONL→lmdb migration. It also adds a native dep to a package that ships `src/` and has no build step (`package.json` `files`).

## libSQL (@libsql/client)

- **Bun.** Local `file:` URLs work (tested). Deps are `@libsql/core`, `@libsql/hrana-client`, `js-base64`, `libsql` (native, through `@neon-rs/load`) and `promise-limit` (package.json).
- **Multi-process.** Tested: with `PRAGMA busy_timeout=5000`, two concurrent processes each ran 300 `batch([...], "write")` increments, then a third ran 300 more. The final value was 900. This is normal SQLite locking.
- **File mode.** `lt.db` came out 0644 (tested). There is no option for it.
- **Change events.** None.
- **Embedded replica / offline.** The README advertises "Works offline with Embedded Replicas" and shows `syncUrl` + `syncInterval` (README.md:54, :67-76). `offline?: boolean` "Enable offline writes" is in `@libsql/core/lib-esm/api.d.ts:23-24`. Tested with `syncUrl` pointing at a dead local port: `createClient` threw `Sync(HttpDispatch(... ConnectionRefused))` from `new Database` (`libsql/index.js:89`) with both `offline: false` and `offline: true`, and no DB file was created. So an embedded replica can't even start without its server, at least for a first open. I did not test whether a replica that already synced keeps working offline, or how conflicts resolve, because both need a real Turso (or self-hosted sqld) database and auth token.
- **Sync.** Turso syncs one database, with a server as the source of truth. There is no peer-to-peer mode.
- **pi-do changes.** The same rewrite as lmdb plus a SQL schema. All calls become async (they are already async-capable through `withLock`). Native dep. Sync would add an account and a token to config.

## Automerge

- **Bun.** WASM loads and runs under Bun (tested). Core has no `dependencies` field in its package.json, but unpacks to 45 MB. `automerge-repo`'s `latest` dist-tag is `2.6.0-alpha.3` (`npm view @automerge/automerge-repo dist-tags`), so "latest" is a prerelease.
- **Merge (tested).** I made a task doc, cloned it, and changed it on both copies: done/name/new tasks on one, a different name and a new task on the other. `A.merge` kept all tasks and both field edits. For the same-field `name` edit it picked one winner and kept the loser in `A.getConflicts` (`{"…":"ONE","…":"uno"}`).
- **Save/load (tested).** `A.save` to a file written with `{ mode: 0o600 }` gave a 446-byte file with mode 600, and `A.load` round-tripped it.
- **Multi-process, raw file (tested): unsafe.** Two processes each looped load→change→`writeFileSync(save())` 100 times on one file with no lock. Both crashed with `RangeError: bad checksum` (torn reads). A CRDT doesn't make the file write safe. pi-do's `withLock` plus temp+rename would still be required, plus a load-merge-save step.
- **Multi-process, automerge-repo + `@automerge/automerge-repo-storage-nodefs` (tested): safe.** Two processes each made 100 changes and called `flush()` on the same doc URL. A third process saw all 201 keys. This works because the adapter writes content-addressed chunk files (`amrepo/<id>/snapshot/<hash>`) instead of overwriting one file. Those files were 0644, with no mode option seen. This adds another package.
- **Change events.** Handles emit change events in-process. Another process's on-disk chunks don't reach a running repo without a network adapter (not tested), so `fs.watch` would still be needed.
- **Sync.** This is Automerge's real strength: offline edits merge without a server in charge. To exchange changes you still need a transport, either a sync server (automerge-repo network adapters) or a shared folder of chunks.
- **pi-do changes.** Model each list as a doc, change task mutations into `change()` callbacks, and replace JSONL I/O and the watch logic. Merges can still conflict per field (shown above), so a UI rule is needed. The biggest change of the three.

## Verdict for pi-do

1. **Keep JSONL (today).** Cost: zero. It is already multi-process safe, 0600, watchable, greppable and dependency-free. None of the three beats it on any property pi-do uses now.
2. **Automerge**, only if multi-device sync becomes a real requirement. It is the only one of the three whose offline-merge story works without an account, and core is 0 deps. Cost: 45 MB, a prerelease `repo`, binary files, a store rewrite, and either the repo package (0644 files) or keeping `withLock` with load-merge-save. A cheaper middle step: keep JSONL and merge by task id plus `updated` timestamp.
3. **lmdb.** Works and is fast, but solves a scale problem pi-do doesn't have (hundreds of tasks). Cost: a native dep, binary files, `chmod` workarounds, and a rewrite with no user-visible gain.
4. **libSQL.** Local mode is just SQLite with a 7.5 MB native addon. `bun:sqlite` (built in) does that for free (see `kv-packages.md`). Sync needs Turso/sqld even to open the replica (tested). Ranked last for pi-do.
