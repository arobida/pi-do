# pi-do

A standalone task panel for Pi. Exposes the `todo_task` tool and a widget above the editor without changing conversation context management.

## Requirements

- Pi coding agent
- Bun for development

## Local development

```sh
bun install
bun test
bun run pack:check
pi install "$PWD"
```

Run `/reload` in Pi after source changes. Pi loads `src/index.ts` directly; no build step is required. Install this package only once; remove any standalone `dex-panel.ts` copy first.

## Usage

- Ask the agent to create, list, start, edit, or complete tasks using `todo_task`.
- `/todos [current|project|completed]` selects and displays a view.
- `/todos export <path>` exports the active backend to todo.txt, without overwriting an existing file.
- `ctrl+shift+t` collapses or expands the panel.
- `ctrl+shift+v` cycles views.

Current shows tasks worked on in this session. Newly created top-level tasks remain in the project backlog until started. By default, tasks are stored in a temporary JSONL file keyed by Pi session ID, one `{"todo":"..."}` object per line. Each `todo` value is a [todo.txt](https://github.com/todotxt/todo.txt) task line; priorities, dates, `+projects` and `@contexts` can be included in the task name. pi-do stores its IDs, start times and optional fields in `piid:`, `pistart:`, `pidesc:`, `piparent:` and `piresult:` metadata tags. Temporary data may be removed by the OS. Set `PI_DO_FILE` to a persistent file path (relative paths are resolved against the project directory) to share tasks across sessions. Avoid concurrent writers to the same file.

To use the optional Dex integration instead, install `dex` on PATH and select the `dex` backend (see Configuration). Dex uses its configured storage when available, or temporary session storage otherwise. Completing a Dex task uses `--no-commit`. Dex remains the source of truth when selected; existing Dex tasks are not copied to the file backend. Dex names carry todo.txt priority, projects and contexts as text. On listing and export, pi-do translates Dex IDs, description, parent, start time, result and completion date into todo.txt metadata and completion markers. Dex's numeric priority and other Dex-specific fields are not translated. Files created by earlier versions (plain todo.txt or the previous JSON-lines format) must be migrated manually; pi-do rejects them rather than overwriting them. For a plain todo.txt file, wrap each task line as a JSON object with a `todo` string property.

## Configuration

Add a `piDo` object to Pi's user settings (`~/.pi/agent/settings.json`, or `$PI_CODING_AGENT_DIR/settings.json`) or trusted project settings (`.pi/settings.json`):

```json
{
  "piDo": {
    "backend": "file",
    "file": ".pi/tasks.jsonl"
  }
}
```

`backend` is `file` (default) or `dex`. `file` is optional; omit it for temporary session storage. Absolute paths and `~/` are supported; relative file paths resolve from Pi's working directory, including when set in user settings. Project settings override user settings per field, and project settings are ignored when Pi does not trust the project. `PI_DO_BACKEND` and `PI_DO_FILE` override settings. Changing the backend or file selects a different task store; it does not migrate tasks. Run `/reload` after editing Pi settings.

For example, set `{"piDo":{"backend":"dex"}}` in project settings to use Dex for that project while retaining the user-level file backend elsewhere. Invalid pi-do settings cause an error rather than silently selecting a different store.

## Publishing later

The Pi manifest and `pi-package` keyword are included. Before the first release, confirm npm name availability (or choose a scope), choose a license, add repository metadata, and review the tarball with `bun run pack:check`. Then publish with `bun publish`. Nothing is published automatically.
