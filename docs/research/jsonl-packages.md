# JSONL packages for pi-do

Date: 2026-11-13. Bun 1.4.4, macOS arm64. Test dir: `/private/tmp/claude-501/-Users-arobida-Dev-Projects-pi-do/68804fd1-bc80-4bc2-91fa-88d16875c41f/scratchpad/jsonl-test`.
This note does not repeat lowdb, steno or keyv. See kv-packages.md for those.

Baseline: `src/util.ts` holds `readJsonl` (strict: it throws on any bad line, with the line number), `withLock` (an `O_EXCL` lock file, 10s stale window) and `home`. Saves write a temp file, then rename it.

## Bun built-in: `Bun.JSONL` (tested)

- It exists in 1.4.4. `Bun.JSONL` has `parse` and `parseChunk` (bun-types 1.4.4 `bun.d.ts:1394-1460`). `Bun.file().lines` doesn't exist (tested: `typeof` is `undefined`).
- `parse("{\"a\":1}\n{\"b\":2}\n")` returns both records (tested).
- **Danger:** with `parse("{\"a\":1}\nbad\n{}")`, Bun gives back `[{a:1}]` and throws nothing. Everything after the bad line is dropped without a warning (tested; documented in `bun.d.ts` ~1416-1418: it throws only if no values parsed before the error). If pi-do used it as is, one corrupt line would truncate a list, and the next save would make that permanent.
- `parseChunk` returns `{values, read, done, error}` and never throws (tested; `bun.d.ts` ~1407-1412). That makes a safe replacement possible: `const r = Bun.JSONL.parseChunk(text); if (r.error) throw ...`. You lose the line number unless you compute it from `read`.
- There is no writer or appender. Writing is still `records.map(JSON.stringify).join("\n")`.

## Candidates

| Package | Version / last publish | Deps | Unpacked | True JSONL? | API |
|---|---|---|---|---|---|
| @seald-io/nedb | 4.1.2 / 2025-07 | 3 (incl. localforage, util) | 715 KB | yes, append-only, one doc per line | Mongo-like `insert/find/update` |
| @alcalzone/jsonl-db | 4.0.2 / 2025-10 | 2 (proper-lockfile fork, alcalzone-shared) | 179 KB | yes, `{"k","v"}` per line, last write wins | `Map`-like `get/set/delete` |
| jsonl-db | 2.0.0 / 2025-08 | 0 | 75 KB | not checked | not checked |
| ndjson | 2.0.0 / 2022-06 | 5 (readable-stream, through2, split2, ...) | 5 KB | stream parse/serialize | Node streams only |
| split2 | 4.2.0 / 2023-03 | 0 | 17 KB | line splitter | Node stream |
| jsonlines | 0.1.1 / 2022-06 | - | - | stale | - |

(Versions, dates, deps and sizes come from `npm view` on 2026-11-13.)

### @seald-io/nedb (tested)
- Format: an append-only datafile, with updates and deletes appended as new lines. It is compacted on every load or on request (`README.md:120-134`; `compactDatafileAsync`, `setAutocompactionInterval`). Docs-only.
- File mode: the `modes: {fileMode: 0o600}` option worked (tested: the file is `600`).
- **Multi-process: not safe (tested).** Two processes each inserted 50 records at the same time. One crashed with `ENOENT: rename 'nedb.db~' -> 'nedb.db'` in `lib/storage.js:248` (both used the same temp filename). After reload the file held 98 records, not 100, so 2 inserts were lost. There is no lock file (none in the README).
- Change events: none across processes (docs-only: the README has no watch).

### @alcalzone/jsonl-db (tested)
- Format: an append log of `{"k":key,"v":value}`. A delete is written as `{"k":key}`. `autoCompress` rewrites the file (`README.md:115`). `throttleFS` buffers writes and can lose data if the process crashes (`README.md:72`).
- **Multi-process: exclusive, not shared (tested).** A second process gets `Failed to lock DB file "az.jsonl"!` from `open()` (proper-lockfile; `README.md:86-95`). That is safe, but pi-do needs short lock-per-write. A long-lived Pi session holding the DB would lock out the CLI and other sessions.
- File mode: the file came out `644`, and I found no mode option (tested; grep of `build/cjs/lib/db.js`). That is worse than pi-do's `0o600`.
- Change events: none across processes (docs-only).

### ndjson / split2 / jsonlines (docs-only)
These are Node-stream line splitters. pi-do reads whole small files, so streaming adds nothing, and ndjson brings 5 deps. jsonlines hasn't been published since 2022.

## Verdict (ranked)

1. **Keep pi-do's helpers. Adopt no dependency.** No candidate has short-lived per-write cross-process locking plus a configurable mode. nedb loses writes across processes, and jsonl-db locks out every process but one and writes `644`.
2. **Optional built-in:** in `readJsonl`, `Bun.JSONL.parseChunk` could replace `split/JSON.parse`, but only if it checks `.error`. Never use bare `Bun.JSONL.parse`, because it drops the rest of the file without an error. The gain is a few characters plus native speed on files that are already small. Not worth it unless profiling says so.
3. **Pattern worth copying (only if rewrite cost ever matters):** the append + compaction log used by nedb and jsonl-db. Append `{"id",...}` or a tombstone under `withLock`, let the last record per id win on read, and compact with the existing temp + rename when the line count is more than 2x the live records. pi-do already appends for its log-style files. For per-list task files of a few KB, a full rewrite is cheaper to reason about, so this is not recommended now.

Tested: Bun.JSONL parse/parseChunk behaviour, nedb mode + two-process race, jsonl-db lock + mode. Docs-only: compaction details, absence of watch APIs, ndjson/split2/jsonlines/jsonl-db (npm metadata only).
