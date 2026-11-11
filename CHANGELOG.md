# Changelog

## Unreleased

- Default file backend stores todos in trusted projects at `.pi-do/` (or `.agents/pi-do/` if present): `config.jsonl`, `todos/lists.jsonl` index and `todos/<name>.todos.jsonl`, starting with a "Hello World" todo. Untrusted projects keep the temporary session file.
- Each JSONL line maps 1:1 to a todo.txt line; new `/todos import <path>` complements export (skips duplicate lines and `piid:`s).
- `~/.pi-do/` holds the global `config.jsonl` and `projects/projects.jsonl`, which tracks every project (`id`, `name`, `path`, `scope`, `created`). Projects are matched by the id in their local `config.jsonl`.
- `/todos scope project|global` moves a project's todos to or from `~/.pi-do/projects/<name>.<id>/`.
- `/todos migrate .pi-do|.agents/pi-do` moves the project store between folders. Trusted projects only.
- `--global` on export/import targets the global store.
- Breaking: `config.jsonl` (global < project < `PI_DO_*` env) replaces the `piDo` block in Pi `settings.json`. New env vars `PI_DO_SCOPE`, `PI_DO_HOME`.

## 0.1.0

- Extract the existing Dex task tool and panel into a standalone Pi package; behavior unchanged.
