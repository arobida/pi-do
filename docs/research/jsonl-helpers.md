# JSONL helpers: what the first note missed

Date: 2026-11-13. Bun 1.4.4, macOS arm64. Scratch: `/private/tmp/claude-501/-Users-arobida-Dev-Projects-pi-do/68804fd1-bc80-4bc2-91fa-88d16875c41f/scratchpad/jsonl2-test`.
Builds on `docs/research/jsonl-packages.md` (Bun.JSONL, nedb, jsonl-db, ndjson, split2, jsonlines) and `docs/research/keyv-lokijs.md`. Not repeated here.

## Need and current code
`readJsonl` (`src/util.ts:23-33`) reads the whole file, splits on `\n`, throws `Invalid JSON on line N of <path>` on a bad line, and rejects non-object records. Returns `[]` on ENOENT. Saves use temp file + rename under `withLock`; `package.json` has zero runtime deps and `typebox` only as a peer. Files are KB-sized, so streaming has no payoff.

Note: the first note called this "strict", and that still holds. The brief says "skips bad lines"; the code at `src/util.ts:27-31` throws instead. Nothing here changes that choice, but note it if skip-and-warn was the intent.

## Candidates (npm metadata via `npm view`, JSR via api.jsr.io, 2026-11-13)

| Package | Version / modified | Deps | Unpacked | What it is | Tolerates bad line? |
|---|---|---|---|---|---|
| tiny-jsonl | 3.0.4 / 2024-10 | 0 | 12.7 KB | `parse`/`stringify` of whole strings | no, throws, no line number (tested) |
| jsonl-parse-stringify | 1.0.3 / 2022-06 | 0 | 1.9 KB | same, stale | not tested |
| js-jsonl | 1.1.1 / 2024-08 | 1 (@sindresorhus/is) | 28 KB | parse/stringify, stale | not tested |
| ndjson-readablestream | 1.4.0 / 2025-09 | 0 | 6.3 KB | async iterator over fetch ReadableStream | docs-only: network oriented |
| it-ndjson | 2.0.0 / 2026-05 | 1 (uint8arraylist) | 57 KB | iterator to ndjson | docs-only |
| @discoveryjs/json-ext | 1.1.0 / 2026-05 | n/a | 184 KB | streaming JSON parse/stringify, not line oriented | docs-only |
| @std/json 1.1.0 + @std/streams 1.2.0 (JSR) | 2026 | json 0 deps | json 236 KB, streams 704 KB on disk | `JsonParseStream`, `TextLineStream`, `JsonStringifyStream` | no, stream errors with `JSON Parse error ... (parsing: 'bad')`, no line number (tested) |
| @effectionx/jsonl-store (JSR) 0.3.1 | - | 5 (effection, std fs/path/json/streams) | - | document store | docs-only; drags in the effection runtime |
| @deepseek-ai/dsh-session-persistence-jsonl, @gobing-ai/ts-llm-jsonl-importer, claude-code-jsonl-parser | 2026 | - | - | app-specific (agent session logs) | not examined, not general helpers |

Schema-validated JSONL: npm search for `jsonl zod` returned no JSONL-specific package, only zod itself and converters. I found no package that pairs a JSONL reader with zod/typebox/valibot. Validation is a one-line step on top of any parser.

## Tests (Bun 1.4.4, input `{"a":1}\nbad\n{"b":2}\n{"c":3` = bad middle line + partial trailing line)
- tiny-jsonl `parse`: throws `JSON Parse error: Unexpected identifier "bad"`. No line number, no skip. Needs `import * as`; it has no default export (tested).
- `@std/json` `JsonParseStream` behind `TextLineStream`: yields `{a:1}`, then throws on `bad`. Everything after is lost, so no resilience either (tested). Needs the stream pipeline, which is more code than `readJsonl`.
- `Bun.JSONL.parseChunk`: `{values:[{a:1}], read:7, done:false, error:{}}`. It stops at the first bad line and reports `read`, so it can't skip past one (tested; matches the first note).
- No candidate can skip a bad line and continue, and none handle a partial trailing line specially. A torn last line (crash mid-append) shows up as an ordinary bad line everywhere.

## Append + compaction, querying
- Append/compaction libraries found are the ones already covered (nedb, jsonl-db) plus `@effectionx/jsonl-store` (heavy deps) and app-specific session stores. Nothing small and lock-aware. Docs-only for effectionx.
- Querying: for JSONL the real tools are CLIs (jq, DuckDB `read_json_auto`), not libraries pi-do would bundle. Not checked in depth; irrelevant at KB scale.

## Using typebox for typed reads (no new dependency)
`typebox` is already a peer. `Value.Check(schema, record)` after `JSON.parse` in `readJsonl` would replace the hand-written object check at `src/util.ts:30` and give typed records. This is the only schema-validation route that adds no dependency. Not tested here; docs-only.

## Verdict (ranked)
1. **Adopt nothing.** Every candidate throws on the first bad line, as `readJsonl` does, but without the line number and path. None skip, repair, or cope with a torn trailing line, and none add locking, mode, or atomic rename. The tiny parsers save about 3 lines and add a dependency to a zero-dep package.
2. **Optional, no dependency:** if a torn trailing line is a real concern (crash during `appendFileSync` on log files), handle it in `readJsonl` itself: ignore an unparseable last line only when the file does not end in `\n`, and keep throwing for middle lines. ~3 lines; untested suggestion.
3. **Optional, no dependency:** `Value.Check` from the peer `typebox` if per-record schemas are wanted.
4. Skip `@std/json`/`@std/streams` (940 KB, stream plumbing, no line numbers), `@effectionx/jsonl-store` and the app-specific session libraries.

## Not checked
jsonl-parse-stringify, js-jsonl, it-ndjson, ndjson-readablestream, json-ext behaviour (metadata only); `@kyoh86/jsonlines` and `@sgcodes/ndjson` on JSR; DuckDB/jq; whether `src/tasks.ts` and `src/store.ts` have call sites that need skip-on-bad-line (not read in detail); `Value.Check` actually exercised.
