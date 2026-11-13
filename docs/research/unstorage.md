# unstorage for pi-do

Researched 2026-11-13 from the published npm tarball and the unjs/unstorage repo. Line numbers point to the published `dist` files at `https://unpkg.com/unstorage@2.0.0-beta.0/<path>`, which are built from `https://github.com/unjs/unstorage/tree/main/src`.

## What pi-do depends on today

- Atomic saves: temp file plus `renameSync`, mode `0o600` (`src/tasks.ts:32`, `src/store.ts:144`).
- Cross-process lock around mutations: `withLock` (`src/util.ts:7`, used at `src/tasks.ts:11`).
- Append-only logs via `appendFileSync` (`src/store.ts:99`, `src/store.ts:109`).
- Exclusive create (`flag: "wx"`) (`src/store.ts:106`).
- JSONC config edited as text so comments survive (`src/store.ts:38`, `src/store.ts:48`).
- `fs.watch` on the folder, because saves replace the file by rename (`src/index.ts:162-169`).

## 1. Version, deps, size

- npm `latest` is **2.0.0-beta.0**; `alpha` is 2.0.0-alpha.11; the last stable 1.x is **1.17.6** (`npm view unstorage dist-tags` / `versions`, https://www.npmjs.com/package/unstorage).
- 2.0.0-beta.0 has **no `dependencies`** in `package.json`. Unpacked size is 185,164 bytes (`dist.unpackedSize`).
- 1.17.6 has 8 hard deps: `h3`, `ufo`, `destr`, `ofetch`, `anymatch`, `chokidar ^5`, `lru-cache`, `node-fetch-native` (`npm view unstorage@1 dependencies`). So on 1.x, chokidar and anymatch get installed for every user.
- On 2.x the fs driver declares chokidar as an optional lib (`^4 || ^5`) and loads it only when `watch()` is called (`dist/drivers/fs.mjs:6-10`, `:82`). anymatch is gone; ignore patterns use Node's `path.matchesGlob` (`dist/drivers/fs.mjs:4`, `:16-21`).
- fs-lite imports only `node:fs`/`node:path` and has no watch (`dist/drivers/fs-lite.mjs:1-4`).

## 2. fs driver behaviour

- **Atomic:** opt-in only (`atomic?: boolean`, `dist/drivers/fs.d.mts:19`). With it set, it writes a temp file and renames it, cleaning up on error (`dist/_chunks/node-fs.mjs:17-33`). Without it, it calls plain `promises.writeFile` (`:20`).
- **File mode:** there is no mode option. An atomic write copies the existing file's mode onto the temp file (`:23-27`). A new file gets the umask default (usually 0o644), not 0o600.
- **Locking:** none. No lock code exists in the driver or in `node-fs.mjs`. Concurrent read-modify-write cycles from two pi processes can lose updates.
- **Append:** none. The driver only has `setItem`/`setItemRaw`, which replace the whole value (`dist/drivers/fs.mjs:59`, `:63`). `lists.jsonl`/`projects.jsonl` would need read, concat and rewrite.
- **Exclusive create:** none.
- **Watch:** uses chokidar on the local base dir and ignores its own temp files (`dist/drivers/fs.mjs:79-100`). Because it watches the filesystem, writes from other processes on the same machine do fire it. Nothing crosses machines.
- **JSONC:** out of scope. unstorage stores values; it does not edit text in place. pi-do's comment-keeping edits stay custom whatever happens.

## 3. Bun

- Neither the README nor `package.json` mentions Bun or sets `engines` (README: https://github.com/unjs/unstorage#readme).
- fs/fs-lite use only `node:fs` and `node:path`, which Bun implements. The fs driver also needs `path.matchesGlob` (Node 22+). I did not check whether Bun ships it, and I did not run anything under Bun. Treat Bun support as likely but **unverified**.

## 4. Backends for cross-machine sync

| Driver | Writes? | Concurrency | Auth | Offline |
|---|---|---|---|---|
| `redis` (needs `ioredis`, loaded via `importLib`, `dist/drivers/redis.mjs:2-10`) | yes | last write wins per key; no CAS through unstorage | password/TLS URL | none; every call needs the network |
| `cloudflare-kv-http` (REST via built-in fetch, `dist/drivers/cloudflare-kv-http.mjs:1-2`) | yes | eventually consistent, last write wins | API token + account id | none |
| `github` (`dist/drivers/github.mjs`) | **no**: it has no `setItem` (0 matches); it only reads a repo tree with a token (`:51`, `:74`) | n/a | token | n/a |
| `http` | yes, to a server you run | whatever the server does | custom headers | none |

Shared problems: pi-do stores a whole list as one JSONL value. With any of these, two machines editing the same list overwrite each other unless pi-do adds per-task keys or merging. None of them works offline, and pi-do has no cache-and-replay layer. The simpler route is already in reach: put `~/.pi-do` in a synced folder (iCloud/Dropbox/Syncthing) or a git repo. That needs no code, works offline, and leaves conflicts to tools built to handle them.

## 5. Verdict: skip (revisit only as an optional remote backend)

- **Do not replace the fs code.** unstorage's fs driver would drop the lock, the 0o600 mode, append and exclusive create, and it would make everything async. pi-do would have to re-add all of that on top, and it would gain nothing it lacks today. It would also add a dependency to a zero-dep extension, and that dependency is on a beta major (or on 1.x, which brings 8 deps including chokidar and anymatch).
- **Optional extra backend:** this is worth doing only if users ask for sync to Redis or Cloudflare KV. Even then, it needs per-task keys and conflict handling, and that design work outweighs the driver wiring. If you build it, pin to stable 2.x once it ships, use a dynamic import so the base install stays zero-dep, and accept that it is online-only.
- For sync now, point users at a synced or git-tracked `~/.pi-do`.
