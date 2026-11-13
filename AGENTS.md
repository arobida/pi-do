# pi-do agent notes

- Generate the codebase summary with `bunx repomix --ignore "node_modules/**,bun.lock"`. `repomix` is not installed globally; always run it through `bunx`. Delete `repomix-output.xml` when done.
- Run tests with `bun test`. Pi loads `src/index.ts` directly; no build step.
- Commit with `wt step commit` (Worktrunk generates the message from the diff via your configured LLM in `~/.config/worktrunk/config.toml`); then `git push`. Do not hand-write commit messages.
