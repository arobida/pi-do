# Store format: switch to typed JSON records

Status: **must change.** Written 2026-11-12.

## Today

Each line of `<name>.todos.jsonl` is JSON with one key, `todo`. Its value is a todo.txt line with pi-do's fields packed in as URL-encoded tags:

```jsonl
{"todo":"(A) Fix login bug +auth piid:7f3e… pistart:2026-11-12T07%3A00%3A00Z pidesc:Token%20expires%20early"}
```

- `src/tasks.ts:21` rejects a line with any key besides `todo`. One bad line stops the whole file from loading.
- `src/tasks.ts:28` saves only `{ todo }`.
- `parseTodo` / `todoLine` (`src/todo.ts`) pack and unpack the tags.

## Dex for comparison

`.dex/tasks.jsonl` stores one full JSON object per task, checked by a Zod schema:

```jsonl
{"id":"abc","parent_id":null,"name":"Fix bug","description":"","priority":1,"completed":false,"result":null,"metadata":null,"created_at":"…","updated_at":"…","started_at":null,"completed_at":null,"blockedBy":[],"blocks":[],"children":[]}
```

| | Dex | pi-do today |
|---|---|---|
| Where fields live | Separate JSON keys, typed (string, number, list) | Tags inside one text string, all strings, URL-encoded |
| Field checks | A Zod schema checks every field | One rule: exactly one key, `todo`, which must be a string |
| Adding a field | Add it to the schema | Add a tag. Older versions keep it as part of the name |
| Lists (`blocks`, `children`) | Native JSON arrays | Repeated tags or a list encoded in one string |
| Editing by hand | You edit JSON | You edit a todo.txt line |
| Old formats | Converted when read | No conversion needed so far |

Not checked: whether Dex rejects keys it doesn't recognize. Zod's default is to drop them quietly rather than fail.

## Why change

- The ideas need lists and links (`pidoc:` links to several files, `piblocks:`). Tags can't hold lists cleanly.
- Everything is a URL-encoded string, so reading a line by hand is harder than it looks.
- The file is named `.jsonl` but the real data is todo.txt text. Two formats in one line doubles the parsing and the edge cases (see `checkName` in `src/todo.ts`).

## Proposed record

```jsonl
{"id":"7f3e…","name":"Fix login bug","priority":"A","completed":false,"started_at":"2026-11-12T07:00:00Z","completed_at":null,"description":"Token expires early","parent":null,"result":null,"docs":["docs/plans/login.md#approach"],"blocked_by":[]}
```

- Store each link on one side only (`parent`, `blocked_by`) and work out the reverse when reading. That's Dex's two-sided upkeep, avoided.
- Keep keys pi-do doesn't recognize when saving instead of rejecting them. That makes the format forward-compatible: older versions can read files written by newer ones.
- `+project`/`@context` can stay in `name` as text, or become `projects` / `contexts` lists. To decide.

## Migration

- When reading, accept both shapes. A line with only a `todo` key goes through `parseTodo`, and everything else is read as the new record. On the next save, write the new shape.
- Places to update: `src/tasks.ts` (the read check and save), `src/todo.ts`, `helloWorld` in `src/store.ts:85`, import/export in `/todos`, the Dex and Things adapters (`src/adapters/`), and the tests.
- Lose: hand-editable todo.txt lines, and `import`/`export` of plain todo.txt, unless `export` keeps converting.
