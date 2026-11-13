# Potential feature: backend integrations (Dex, Things 3)

Status: idea, not started (2026-11-11).

## Today
Dex is an inline branch in `src/index.ts` (~line 223, `if (backend === "dex")`), shelling out to `dex` and mapping JSON via `dexTodo`.

## API surfaces
| | Dex | Things 3 |
|---|---|---|
| Read | `dex list --json` | URL scheme cannot read. Use `osascript` (JXA, `to dos of list "Today"`) or read-only SQLite (unsupported) |
| Create | CLI, returns id | `things:///add?title=&notes=&list=`; id only via x-callback (hard from CLI). `things:///json` / AppleScript `make new to do` better |
| Update/complete | CLI by id | `things:///update?id=&auth-token=&completed=true` (needs user auth token) |
| Fields | id, name, completed, started_at, description, parent, result | title, notes, when/deadline, tags, project/area, checklist; no started/result |
| Platform | any | macOS only, app launches |

Ref: https://culturedcode.com/things/support/articles/2803573/

## Proposed layer (keep small)
```ts
interface Backend {
  list(): Promise<Task[]>;
  create(t: Partial<Task>): Promise<string>;              // external id
  update(id: string, patch: Partial<Task>): Promise<void>; // start/complete/edit = patches
}
```
1. Normalize to existing `Task` (like `dexTodo`).
2. Fields with no backend slot: Things `started_at` -> `pi-started` tag; description/result -> marker block in notes.
3. Use external id as `Task.id`; no mapping table.
4. Keep validation at boundary (`checkName`, throw on malformed external data).
5. Clear errors for missing setup (no auth token, not macOS).

Things adapter: one `osascript -l JavaScript` call per op (avoids auth token + callback problems).

## Out of scope
- Two-way sync engine (conflicts/tombstones). One source of truth per store via `config.jsonl` `backend`; move data with existing todo.txt import/export.
- General plugin system until a third backend exists.
- `parent` -> Things projects/checklists (checklist items have no ids); keep parent in notes.

## Next steps
1. Move Dex behind `Backend`, no behavior change, tests green.
2. Add Things adapter.

Unverified: JXA property names, whether `things:///json` returns ids without callback, tag behavior, automation permission prompts on first use.
