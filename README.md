# pi-do

A Dex-backed task panel for Pi. Exposes the `dex_task` tool and a widget above the editor without changing conversation context management.

## Requirements

- Pi coding agent
- `dex` CLI on PATH
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

- Ask the agent to create, list, start, edit, or complete tasks using `dex_task`.
- `/todos [current|project|completed]` selects and displays a view.
- `ctrl+shift+t` collapses or expands the panel.
- `ctrl+shift+v` cycles views.

Current shows tasks worked on in this session. Newly created top-level tasks remain in the project backlog until started. Configured Dex storage is used when available; otherwise tasks use a temporary directory keyed by Pi session ID. Temporary data may be removed by the OS. Completing a task uses `--no-commit`.

## Publishing later

The Pi manifest and `pi-package` keyword are included. Before the first release, confirm npm name availability (or choose a scope), choose a license, add repository metadata, and review the tarball with `bun run pack:check`. Then publish with `bun publish`. Nothing is published automatically.
