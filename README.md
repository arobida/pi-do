# pi-do

A standalone task panel for Pi. Exposes the `todo_task` tool and a widget above the editor without changing conversation context management.

## Features

- **Task panel widget** — live task list rendered above the editor; collapsible, with current/project/completed views.
- **`todo_task` tool** — the agent can create, list, start, edit, and complete tasks on request.
- **todo.txt format** — task lines support priorities, dates, `+projects` and `@contexts`; pi-do metadata travels in `piid:`, `pistart:` and related tags.
- **Two storage backends** — a built-in JSONL file backend (temporary per-session by default, or a persistent file you choose) and an optional Dex integration via the `dex` CLI.
- **Export** — dump the active backend to a plain todo.txt file with `/todos export <path>`.
- **Live reload** — the panel watches task storage and refreshes when other agents change it.

## Requirements

- Pi coding agent
- Optional: `dex` on PATH for the Dex backend

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
- `/todos import <path> [--global]` appends todo.txt lines verbatim (file backend), skipping lines or `piid:`s already present.
- `/todos migrate .pi-do|.agents/pi-do` moves the project-scope store folder (todos, config, index). Trusted projects only; refuses to overwrite.
- `/todos scope project|global` switches scope and moves the `todos/` folder between the project folder (`.pi-do/` or `.agents/pi-do/`) and `~/.pi-do/projects/<name>.<id>/`. Refuses if the target already has todos. Trusted projects only.
- `--global` targets this project's store under `~/.pi-do/projects/<name>.<id>/` instead of the active one.
- `ctrl+shift+t` collapses or expands the panel.
- `ctrl+shift+v` cycles views.

Current shows tasks worked on in this session. Newly created top-level tasks remain in the project backlog until started. Tasks are stored as JSONL, one `{"todo":"..."}` object per line. Each `todo` value is a [todo.txt](https://github.com/todotxt/todo.txt) task line; priorities, dates, `+projects` and `@contexts` can be included in the task name. pi-do stores its IDs, start times and optional fields in `piid:`, `pistart:`, `pidesc:`, `piparent:` and `piresult:` metadata tags. Each JSONL line maps 1:1 to a todo.txt line, so export/import round-trip exactly. Avoid concurrent writers to the same file.

## Storage

| Scope | Todos file |
|---|---|
| `project` (default, trusted projects) | `.pi-do/todos/<project>.todos.jsonl`, or `.agents/pi-do/...` if that exists |
| `global` | `~/.pi-do/projects/<project>.<id>/todos/<project>.todos.jsonl` |
| `temp` (and untrusted projects) | same layout under `$TMPDIR/pi-do/<session-hash>/.pi-do/`; may be removed by the OS |

On first use pi-do creates the folder with an empty `config.jsonl`, a `todos/lists.jsonl` index (`id`, `name`, `file`, `created` per todos file) and a starter `Hello World` todo (new permanent stores, and on the first run after install even if temp; otherwise temp stores start empty). Each project's id is stored in its local `config.jsonl` (which stays in the project in both scopes) and keys its record in `~/.pi-do/projects/projects.jsonl` (`id`, `name`, `path`, `scope`, `created`). `scope: "global"` projects keep their store in `~/.pi-do/projects/<name>.<id>/`; `project` scope creates no global folder. `<project>` is the working directory's name.

To use the optional Dex integration instead, install `dex` on PATH and select the `dex` backend (see Configuration). Dex uses its configured storage when available, or temporary session storage otherwise. Completing a Dex task uses `--no-commit`. Dex remains the source of truth when selected; existing Dex tasks are not copied to the file backend. Dex names carry todo.txt priority, projects and contexts as text. On listing and export, pi-do translates Dex IDs, description, parent, start time, result and completion date into todo.txt metadata and completion markers. Dex's numeric priority and other Dex-specific fields are not translated. Files created by earlier versions (plain todo.txt or the previous JSON-lines format) must be migrated manually; pi-do rejects them rather than overwriting them. For a plain todo.txt file, wrap each task line as a JSON object with a `todo` string property.

## Configuration

`config.jsonl` files hold one JSON object of options per line (later lines win): `~/.pi-do/config.jsonl` (global) < the project's pi-do `config.jsonl` < environment (`PI_DO_BACKEND`, `PI_DO_FILE`, `PI_DO_SCOPE`). `PI_DO_HOME` moves `~/.pi-do`.

```json
{"backend": "file", "scope": "project"}
```

- `backend`: `file` (default) or `dex`.
- `scope`: `project` (default), `global` or `temp`; read from the global config or `PI_DO_SCOPE`.
- `file`: explicit todos file, overriding scope. `~/` supported; relative paths resolve from Pi's working directory.

Changing backend, scope or file selects a different store; it does not migrate tasks (use export/import). Invalid config causes an error rather than silently selecting a different store. Run `/reload` after editing config.

## Development

Tech stack, project structure, local development, and publishing: see [CONTRIBUTING.md](CONTRIBUTING.md).
