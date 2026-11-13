# LMDB and lmdb-js for pi-do

Researched 2026-11-13 on Bun 1.4.4, macOS arm64, umask 022. Follows `lmdb-libsql-automerge.md`, which already showed lmdb 3.5.9 works under Bun, loses no updates across two processes, writes 0644 files, and pulls 6 deps plus a 1.4 MB native prebuild. Those results are not repeated here.

Sources:
- **C library.** The LMDB source that lmdb-js vendors in its npm tarball (`npm pack lmdb@3.5.9`, `dependencies/lmdb/libraries/liblmdb/`). It reports itself as 0.9.90 (`lmdb.h:234-238`). It is the Symas `mdb.master3`-line code, with encryption (`chacha8.c`, `crypto.c`) and remap-chunks support that stock 0.9.x lacks. Cites below are `lmdb.h`, `mdb.c` and `mdb_copy.1` from that directory.
- **lmdb-js.** `README.md`, `package.json`, `index.d.ts`, `open.js` and `src/*.cpp` from the same tarball.
- **npm.** `npm view lmdb time maintainers dependencies optionalDependencies`.

Tags: **tested** means I ran it in `scratchpad/kv-test/t2` under Bun. **docs** means the claim comes only from the cited source.

## How pi-do stores data today

- One JSONL file per list under `~/.pi-do`.
- Writes take a `wx` lock file with a 10 s stale window (`src/util.ts:7-21`), then write a temp file and rename it into place (`src/tasks.ts:32`).
- Files use mode `0o600` (`src/tasks.ts:32`, `src/store.ts:106`).
- `fs.watch` on the folder triggers a refresh (`src/index.ts:152-171`).
- No runtime deps.
- Lists hold tens to hundreds of tasks.

## Findings

### MVCC, single writer, concurrent readers (docs, plus prior test)
- Writes are fully serialized: "only one write transaction may be active at a time", so writers can't deadlock (`lmdb.h:20-24`).
- Readers take no locks. Writers don't block readers, and readers don't block writers (`lmdb.h:24-25`).
- lmdb-js recommends multiple processes for concurrency (README.md:415). It provides optimistic `ifVersion` writes (README.md:417-436) and serialized `db.transaction` read-modify-write (README.md:143-171).
- The prior doc tested 2×500 cross-process increments with no lost updates.

### ACID and crash safety (tested)
- Copy-on-write: "no active data pages are ever overwritten", which "eliminates the need of any special recovery procedures after a system crash" (`lmdb.h:20-23`). There is no WAL and no log to checkpoint (`lmdb.h:27-34`).
- lmdb-js says that with default sync settings "a machine can be turned off at any point, and data can not be corrupted" (README.md:46).
- **Caveat 1, overlappingSync.** lmdb-js turns on `overlappingSync` by default on non-Windows (README.md:538, 561-575). A commit becomes visible before it is flushed to disk; you await `db.flushed` for durability. After an OS crash the library may fall back to the last *flushed* transaction (`safeRestore`, README.md:557). The result is atomic, but recent commits are not guaranteed durable unless you await `flushed`.
- **Caveat 2, unsafe flags.** `noSync` and `useWritemap` trade safety for speed (README.md:549, 553; `lmdb.h:661-677`).
- On macOS, fsync is `F_FULLFSYNC` plus a barrier (`mdb.c:180-184`).
- **Test.** A process ran read-modify-write transactions in a loop (bump a counter, write key `k<n>`). I killed it with `kill -9` after about 1 s, three times. On every reopen the counter matched the key count, with no missing keys (189/190, 397/398, 616/617). That is no torn state. This covers a process crash only, not power loss.

### Memory-mapped reads and performance (docs)
- Reads come straight from the map with "no malloc's or memcpy's" (`lmdb.h:9-13`).
- lmdb-js reads are synchronous and writes are async-batched (README.md:42-44). The README badges claim 8.5M gets/s and 1.7M puts/s (README.md:4-5).
- pi-do's lists are a few KB, so this speed has no visible effect.

### Map size limits and growth (docs)
- In C, the map size *is* the maximum DB size. It defaults to 10 MB, should be set "as large as possible", and can only grow while no transaction is active in the process. Other processes see `MDB_MAP_RESIZED` (`lmdb.h:924-956`).
- lmdb-js "automatically handles database growth" (README.md:50). `mapSize` is optional (README.md:552).
- The reserved address space is not real memory or disk use (`lmdb.h:81-84`).
- Maximum key size is 511 bytes by default (`mdb.c:671-672`).

### File growth, no shrink, free-page reuse, compaction (tested)
- The C docs say free pages are tracked and reused, "so the database size does not grow without bound in normal use" (`lmdb.h:31-34`). Long-lived read transactions block reuse (`lmdb.h:107-110`).
- **Test** (20k × 1 KB values):

  | step | `data.mdb` size |
  |---|---|
  | empty | 32 KB |
  | after 20k puts | 23.5 MB |
  | **after deleting all** | **23.6 MB (no shrink)** |
  | 3 cycles of put 10k / delete 10k | 23.6 MB → 36.6 MB → 36.6 MB |

  Free pages were reused, but the file still grew about 55% before it settled.
- Compaction needs a copy: `mdb_copy -c` (`mdb_copy.1:41-45`), or `db.backup(path, true)` (`index.d.ts:315-317`).
- **Test.** A compacting backup of the 36.6 MB file came out at **48 KB**. The `path` must be an existing directory. Passing a file path fails with `No such file or directory`, even though `open.js:431-433` creates its parent dir.
- Swapping the compacted copy in place needs every process to close the DB first.

### Stale readers and the lock table after crashes (docs; test inconclusive)
- A killed process can leave reader slots behind. These pin old pages, so the file grows, and "stale locks can block further operation". The fix is `mdb_reader_check` or `mdb_stat -r` (`lmdb.h:48-58`, `lmdb.h:115-127`).
- The lock file "is always reset on first open of the environment" (`lmdb.h:58`).
- lmdb-js calls `mdb_reader_check` when the reader table is full (`src/txn.cpp:82-84`) and every 10 minutes from the writer (`src/writer.cpp:522-531`). It also exposes `readerCheck()` (`src/env.cpp:917-923`).
- Stale writers: on macOS, LMDB uses POSIX semaphores unless built with `MDB_USE_ROBUST` (`mdb.c:170-171`). lmdb-js builds robust by default (`binding.gyp:109-110`, README.md:636) so a dead writer doesn't hang others. The README notes a macOS limit of 10 robust semaphores (README.md:638).
- **Test.** I held a read txn, killed the process with `kill -9`, then reopened. `readerList()` showed no active readers. That fits the reset-on-first-open rule, but it says nothing about the case where another process keeps the env open.

### Network filesystems and cloud-sync folders (docs)
- "Do not use LMDB databases on remote filesystems, even between processes on the same host. This breaks flock() on some OSes, possibly memory map sync, and certainly sync between programs on different hosts" (`lmdb.h:129-132`).
- iCloud and Dropbox aren't named. A syncer copying `data.mdb` while it is mmapped and being written can upload a torn snapshot. It would also sync `lock.mdb`. That is an inference from the copy-on-write and lockfile design, not a documented claim.
- JSONL plus rename is much safer there: every save is a whole file.

### File permissions (tested)
- C `mdb_env_open(env, path, flags, mode)` takes "the UNIX permissions to set on created files and semaphores" (`lmdb.h:729-742`).
- lmdb-js defaults to `0664` and reads an **undocumented** `permissionsMode` option (`src/env.cpp:327-330`, passed through at `:351`). It appears in neither README.md nor `index.d.ts`.
- **Test.** `open({ path, permissionsMode: 0o600 })` created `data.mdb` and `lock.mdb` as **600**. The default gives 0644 under umask 022 (prior doc). This replaces the prior doc's "chmod workaround": it works, but it isn't part of the public API. In TypeScript it needs `as any`.
- A directory is still created with umask defaults (0755 here). On-disk encryption is available via `encryptionKey` (README.md:542).

### lmdb-js extras (docs)
- **Encoding.** Default `msgpack` via msgpackr. Also `json`, `cbor`, `string`, `ordered-binary` and `binary` (README.md:509, 577-584). Optional shared structures (README.md:440-450).
- **Compression.** Off-thread LZ4, off by default. Every open must use the same setting (README.md:452-471).
- **Async batched writes.** Writes in one event turn go into one transaction (`eventTurnBatching`, README.md:541). There is also `commitDelay` (README.md:543).
- **Caching.** Weak LRU cache, off by default (README.md:473-488).
- **`dupSort`.** Multiple values per key, for indexes (README.md:530, 270-296).
- **Change events.** Only `beforecommit`, which is in-process (README.md:593-597). There is no cross-process notification, so pi-do would still need `fs.watch` on `data.mdb`.

### Platform and native binary (docs, plus prior test)
- Prebuilds come as `optionalDependencies` `@lmdb/lmdb-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,linux-arm,win32-x64,win32-arm64}` (npm view).
- Install runs `node-gyp-build-optional-packages` (`package.json:59`). It falls back to a source build (`binding.gyp`), which needs a C toolchain on platforms without a prebuild.
- Bun works through Node-API (README.md:7, 30). The prior doc tested it on Apple Silicon.
- The mmap and lock behaviour is per-OS (`mdb.c:114`, `:167-184`). Mixing `useWritemap` and non-writemap processes on one DB is forbidden (`lmdb.h:651`).

### Maintenance (npm)
- Maintainers: kriszyp, chjj, rvagg. Kris Zyp writes nearly all of it; the README links his msgpackr and weak-lru-cache.
- Releases in 2026: 3.5.0 (Jan 23), 3.5.1, 3.5.2, 3.5.3, 3.5.4, 3.5.5, 3.5.6, 3.5.7, 3.5.8, and 3.5.9 (Oct 23). That is about one release a month, with gaps up to 3.5 months. Active.
- It is used by Parcel, Kibana, HarperDB and Gatsby (README.md:17).
- Upstream LMDB itself is mature and slow-moving (copyright 2011-2021, `lmdb.h:136`).

### Data portability (docs)
- Data lives in binary `data.mdb` B+tree pages holding msgpack values. You can't grep, `cat`, diff or hand-edit them, and git can't merge them.
- Inspection needs `mdb_stat` and `mdb_dump`/`mdb_load`, whose sources ship in the tarball (`mdb_dump.c`, `mdb_stat.c`). They are not installed here (`which mdb_stat` found nothing), and `mdb_dump` would show msgpack bytes, not JSON.
- The file format is tied to the LMDB build. lmdb-js's 0.9.90 fork with encryption and remap is not guaranteed to be readable by a stock `mdb_dump`. That is not tested.

## Pros
- Real ACID transactions across processes with no lost updates (prior test). Crash-safe with no recovery step: tested with `kill -9`.
- Readers never block. Reads are synchronous and very fast.
- Could replace `withLock` (`src/util.ts:7-21`) and temp+rename (`src/tasks.ts:32`) with `db.transaction`.
- `permissionsMode: 0o600` works (tested), as does optional encryption.
- Handles stale writers via robust locks, and checks readers periodically in lmdb-js.
- Actively maintained, widely used, prebuilt for Apple Silicon. Works on Bun.

## Cons
- Adds a native dep and 6 JS deps to a zero-dep extension that ships raw `src/`. A source build is needed on platforms without a prebuild.
- Binary files: not greppable, diffable, hand-editable or git-friendly. Debugging needs `mdb_dump`, which isn't installed and would show msgpack anyway.
- The file never shrinks: tested 23.6 MB after deleting everything. Compaction requires a copy and all processes closed.
- `permissionsMode` is undocumented and untyped.
- The default `overlappingSync` makes the latest commits non-durable until `flushed`.
- Unsafe on network filesystems (`lmdb.h:129`), and risky in iCloud or Dropbox folders. JSONL is fine there.
- No cross-process change events, so `fs.watch` is still needed.
- Stale-reader and lockfile caveats (`lmdb.h:48-127`) are new failure modes pi-do doesn't have today.
- A full store rewrite plus a JSONL migration.

## Verdict for pi-do
Don't adopt it. LMDB is a well-engineered fix for high write rates on large data and many concurrent readers. pi-do writes a few KB a few times a minute. Its lock + rename JSONL store already gives atomic, multi-process-safe, 0600, watchable, greppable files with zero deps. LMDB would trade those properties for a native binary, files that only grow, and new lockfile and cloud-folder hazards, with no gain users would see. Revisit only if lists reach tens of thousands of tasks, or if profiling shows file rewrites are the bottleneck. Even then, `bun:sqlite` (built in, no dep) is the cheaper step.
