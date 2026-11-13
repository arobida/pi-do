# pi-do

A standalone task panel for Pi. Exposes the `todo_task` tool and a widget above the editor without changing conversation context management.

## Features

- **Task panel widget** — live task list rendered above the editor; collapsible, with current/project/completed views.
- **`todo_task` tool** — the agent can create, list, start, edit, and complete tasks on request.
- **todo.txt format** — import/export todo.txt lines; priority, dates and pi-do fields are stored as separate JSON keys.
- **One store, synced adapters** — tasks live in pi-do's JSONL file; an optional Dex adapter syncs both ways via the `dex` CLI.
- **Export** — dump the store to a plain todo.txt file with `/todos export <path>`.
- **Live reload** — the panel watches task storage and refreshes when other agents change it.

## Requirements

- Pi coding agent
- Optional: `dex` on PATH for the Dex adapter

## Installation

Once published:

```sh
pi install pi-do
```

Until then, install from a local checkout (see [Contributing](CONTRIBUTING.md)).

## Usage

- Ask the agent to create, list, start, edit, or complete tasks using `todo_task`.
- `/todos [current|project|completed]` selects and displays a view.
- `/todos export <path> [--global]` exports to todo.txt, without overwriting an existing file.
- `/todos import <path> [--global]` appends todo.txt lines as records, skipping `piid:`s already present.
- `/todos connect things <token>` saves the Things auth token (see the Things adapter docs).
- `/todos migrate .pi-do|.agents/pi-do` moves the project-scope store folder (todos, config, index). Trusted projects only; refuses to overwrite.
- `/todos scope project|global` switches scope and moves the `todos/` folder between the project folder (`.pi-do/` or `.agents/pi-do/`) and `~/.pi-do/projects/<name>.<id>/`. Refuses if the target already has todos. Trusted projects only.
- `--global` targets this project's store under `~/.pi-do/projects/<name>.<id>/` instead of the active one.
- `ctrl+shift+t` collapses or expands the panel.
- `ctrl+shift+v` cycles views.

Current shows tasks worked on in this session. Newly created top-level tasks remain in the project backlog until started. Tasks are stored as JSONL, one JSON object per task: `id`, `name`, `completed`, `started_at`, and optional `priority` (A-Z), `created` and `completed_date` (YYYY-MM-DD), `description`, `parent`, `result` (schema: `Task` in `src/todo.ts`). `+projects`, `@contexts` and other `key:value` tags stay in `name`. Export renders each record as a [todo.txt](https://github.com/todotxt/todo.txt) line, with pi-do fields as `piid:`, `pistart:`, `pidesc:`, `piparent:` and `piresult:` tags, so import reads it back. Older `{"todo":"..."}` stores are converted on the next write. Avoid concurrent writers to the same file.

## Storage

| Scope | Todos file |
|---|---|
| `project` (default, trusted projects) | `.pi-do/todos/<project>.todos.jsonl`, or `.agents/pi-do/...` if that exists |
| `global` | `~/.pi-do/projects/<project>.<id>/todos/<project>.todos.jsonl` |
| `temp` (and untrusted projects) | same layout under `$TMPDIR/pi-do/<session-hash>/.pi-do/`; may be removed by the OS |

On first use pi-do creates the folder with a `config.json`, a `todos/lists.jsonl` index (`id`, `name`, `file`, `created` per todos file) and a starter `Hello World` todo (new permanent stores, and on the first run after install even if temp; otherwise temp stores start empty). Each project's id is stored in its local `config.json` (which stays in the project in both scopes) and keys its record in `~/.pi-do/projects/projects.jsonl` (`id`, `name`, `path`, `scope`, `created`). `scope: "global"` projects keep their store in `~/.pi-do/projects/<name>.<id>/`; `project` scope creates no global folder. `<project>` is the working directory's name.

Adapters sync pi-do's store with other todo apps. Each has its own connect instructions, capabilities and limitations:

- [Dex](src/adapters/dex/README.md)
- [Things 3](src/adapters/things/README.md)

## Configuration

`config.json` files are JSONC (comments and trailing commas allowed) and start with a `$schema` URL pinned to your installed version, so editors autocomplete and check every option ([`schema.json`](schema.json); each adapter's options are in `src/adapters/<name>/<name>.schema.json`). pi-do keeps that URL current when you upgrade, and converts an older `config.jsonl` automatically. Precedence: `~/.pi-do/config.json` (global) < the project's pi-do `config.json` < environment (`PI_DO_FILE`, `PI_DO_SCOPE`). `PI_DO_HOME` moves `~/.pi-do`.

```json
{"adapters": {"dex": {"sync": true}}, "scope": "project"}
```

- `adapters`: per-adapter options; `dex` or `things`, each with `sync` (boolean).
- `scope`: `project` (default), `global` or `temp`; read from the global config or `PI_DO_SCOPE`.
- `file`: explicit todos file, overriding scope. `~/` supported; relative paths resolve from Pi's working directory.

Changing scope or file selects a different store; it does not migrate tasks (use export/import). Invalid config causes an error rather than silently selecting a different store. Run `/reload` after editing config.

## Development

Tech stack, project structure, local development, and publishing: see [CONTRIBUTING.md](CONTRIBUTING.md).
