# Bun JSONL and file APIs vs pi-do's node:fs calls

Date: 2026-11-13. Bun 1.4.4 (`bun --version`), macOS arm64, umask 022.
Builds on `docs/research/jsonl-packages.md` and `docs/research/jsonl-helpers.md`.
Tests: `/private/tmp/claude-501/-Users-arobida-Dev-Projects-pi-do/68804fd1-bc80-4bc2-91fa-88d16875c41f/scratchpad/bun-api-test/t.ts` and `t2.ts`.
Types cited from `~/.bun/install/cache/bun-types/1.4.4@@@1/` (written `bun.d.ts:N` below).
**T** = tested under Bun 1.4.4. **D** = docs/types only.

## Verdict first

**Pi runs extensions under Node, so pi-do cannot use any `Bun.*` API.** Evidence (T, read on disk):
- `~/.bun/bin/pi` starts with `#!/usr/bin/env node`.
- `@earendil-works/pi-coding-agent/package.json`: `"bin": {"pi": "dist/bundle/cli.js"}`, `"engines": {"node": ">=22.19.0"}`, and depends on `"jiti": "2.7.0"`. Extensions load via `dist/core/extensions/jiti-static-loader.js`.
- `dist/config.js:20`: `export const isBunRuntime = !!process.versions.bun;`. Pi supports both runtimes, and the installed launcher picks Node.
- pi-do's `package.json` declares `"pi": {"extensions": ["./src/index.ts"]}` and nothing that forces Bun. Bun is only the test runner and package manager.

Under Node, `Bun` is undefined and the first call throws. Even under Bun, the swaps would lose things (below). **Keep node:fs. Not worth it.**

## 1. Bun.JSONL

API (D, `bun.d.ts:1398-1486`): only `Bun.JSONL.parse(input)` and `Bun.JSONL.parseChunk(input, start?, end?)`. Input is a string, TypedArray, DataView or ArrayBuffer. `parseChunk` returns `{ values: unknown[], read: number, done: boolean, error: SyntaxError | null }` (`bun.d.ts:1402-1411`). `read` counts characters for strings and bytes for typed arrays. No stringify or writer: `Object.keys(Bun.JSONL)` is `["parse","parseChunk"]` (T).

| Case | `parse` | `parseChunk` |
|---|---|---|
| Bad middle line `{"a":1}\nbad\n{"c":3}` | returns `[{a:1}]` and **silently drops the rest** (T; documented `bun.d.ts:1416-1418`) | `values:[{a:1}], read:7, done:false, error: SyntaxError "Failed to parse JSONL"` (T) |
| Bad first line | throws `SyntaxError: Failed to parse JSONL`, with no line number (T) | — |
| Torn trailing line `{"a":1}\n{"b":` | `[{a:1}]` silently (T; `bun.d.ts:1420-1421`) | `read:7, done:false, error:null` (T), so you can tell it apart from a bad line |
| `\r\n` | parsed fine (T) | — |
| Empty or whitespace lines | skipped (T) | — |
| BOM in a string | throws (T) | — |
| BOM as UTF-8 bytes | parsed fine (T) | — |
| No trailing newline | last value kept (T) | — |
| Non-object values (`1`, `"s"`, `[1]`, `null`) | returned as-is (T), so pi-do's object check is still needed | — |
| Two values on one line `{"a":1}{"b":2}` | returns `[{a:1}]` and drops the second (T) | — |
| `start`/`end` | — | `parseChunk(s, 8)` parses from offset 8, `read:15` (T) |

Streaming (T): `Bun.file(p).stream()` with a byte buffer, `parseChunk`, then `subarray(read)` read all 1000 records. A 110 KB file arrived as one chunk. Typed-array input is zero-copy for ASCII (D, `bun.d.ts:1423-1424`).

Performance (T, 200k lines / 15.8 MB, mean of 5 runs): `split+JSON.parse` 43.0 ms, `JSONL.parse` string 32.0 ms, bytes 33.3 ms. That is about 25% faster, which is irrelevant for pi-do's KB-sized files.

**Fit for `readJsonl` (`src/util.ts:23-33`): worse.** `parse` drops data after a bad line without an error. That is a data-loss trap for a store that later rewrites the whole file via `save()`. pi-do would need `parseChunk`, then its own error with a line number (computed from `read`), then the object check. That is more code than the current 10 lines.

## 2. File APIs

| API | Finding | T/D |
|---|---|---|
| `Bun.file(path)` → `BunFile` (`bun.d.ts:4890`, interface `bun.d.ts:2682`) | Lazy. `text()`, `json()`, `bytes()`, `stream()`, `exists()`, `stat()` (`:2778`, returns node `Stats`), `delete()`/`unlink()` (`:2768-2773`), `writer()` (`:2718`), plus `size`, `type`, `lastModified`, `name` | T |
| Missing file | `exists()` is false and `size` is 0. `text()` rejects with `code: "ENOENT"`, so the `readJsonl` ENOENT branch would carry over | T |
| `delete()` on a missing file | rejects ENOENT (no `force`) | T |
| `Bun.write(dest, data, {mode, createPath})` (`bun.d.ts:2151-2167`) | `createPath` defaults to true and creates parent dirs. `createPath:false` gives ENOENT | T |
| `Bun.write` `mode` | **Ignored:** `{mode: 0o600}` produced 0644 on a new file, for both string and bytes input, with umask 022 (T, `t2.ts`). Types say it applies to PathLike destinations (`bun.d.ts:2156`) | T |
| `Bun.write` atomicity | **Not atomic:** the inode is unchanged after an overwrite, so it truncates in place, with no temp file + rename | T |
| `Bun.write` append / exclusive | No append flag. A second write overwrites. No `wx`/exclusive option in the type | T / D |
| `FileSink` (`s3.d.ts:7-66`: `write`, `flush`, `end`, `start`, `ref`, `unref`) | `Bun.file(p).writer()` on an existing file **truncates** (`"3\n"` replaced `"1\n2\n"`). There is no append mode. A new file gets 0644 | T |
| fsync / rename | No Bun API in the types. Use `node:fs` | D |
| Watch | `Bun.watch` is undefined. Bun relies on `node:fs.watch` | T |
| `Bun.Glob` (`bun.d.ts:9370`) | `new Bun.Glob("**/*.txt").scanSync(dir)` works. pi-do does not glob | T |

## 3. pi-do's node:fs calls, one by one

| Call | Where | Bun replacement? |
|---|---|---|
| `readFileSync(path,"utf8")` | `src/util.ts:25`, `src/tasks.ts:15`, `src/store.ts:8,30,35,52`, `src/index.ts` | `await Bun.file(p).text()`, but async-only, which would ripple through sync callers. **Stay** |
| `writeFileSync(temp, …, {mode:0o600})` + `renameSync` | `src/tasks.ts:32` | Bun.write drops 0600 and has no rename. **Must stay** |
| `writeFileSync(lock, pid, {flag:"wx"})` | `src/util.ts:10` (the lock) | No exclusive create in Bun. **Must stay** (the lock depends on it) |
| `writeFileSync(file, …, {flag:"wx", mode:0o600})` | `src/store.ts:106` | **Must stay** (wx + 0600) |
| `appendFileSync` | `src/store.ts:99,109` | No append in Bun.write or FileSink. **Must stay** |
| `writeFileSync` (config, temp registry) + `renameSync` | `src/store.ts:22,39,55,144` | Bun.write could do the plain config write, but that saves nothing. **Stay** |
| `statSync`, `unlinkSync` | `src/util.ts:14,20` | `BunFile.stat()`/`delete()` are async-only. **Stay** |
| `mkdirSync` recursive, `existsSync`, `cpSync`, `rmSync` | `src/store.ts`, `src/tasks.ts:10`, `src/index.ts` | Only implicit via `createPath`. No Bun equivalents for the rest. **Stay** |
| `fs.watch` | `src/index.ts:165` | No Bun-native watch. **Stay** |

Replaceable without losing atomicity, 0o600, wx, append or locking: in theory only the plain reads and the non-sensitive config writes, and only under Bun. Since Pi loads extensions under Node, **none**.

## Recommendation
Change nothing. If you want the JSONL speedup in tests or tooling that runs only under Bun, guard it with `typeof Bun !== "undefined"`. It is not worth the branch at pi-do's file sizes.

Not checked: oven-sh/bun source on GitHub (types and tests were enough to settle each claim); Windows behaviour; whether a later Bun honours `mode` (this may be a 1.4.4 bug worth filing).
