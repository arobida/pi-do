# pi-do agent rules

- Generate the codebase summary with `bunx repomix --ignore "node_modules/**,bun.lock"`. `repomix` is not installed globally; always run it through `bunx`. Delete `repomix-output.xml` when done.
- Run tests with `bun test`. Pi loads `src/index.ts` directly; no build step.
- Commit with `wt step commit` (Worktrunk generates the message from the diff via your configured LLM in `~/.config/worktrunk/config.toml`); then `git push`. Do not hand-write commit messages.

## Code Search

Use `semble search` to find code by describing what it does or naming a symbol, instead of grep:

```bash
semble search "authentication flow" ./my-project
semble search "save_pretrained" ./my-project
semble search "save model to disk" ./my-project --top-k 10
```

Use `semble find-related` to discover code similar to a known location (pass `file_path` and `line` from a prior search result):

```bash
semble find-related src/auth.py 42 ./my-project
```

`path` defaults to the current directory when omitted; git URLs are accepted.

If `semble` is not on `$PATH`, use `uvx --from "semble[mcp]" semble` in its place.
