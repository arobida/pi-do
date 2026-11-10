# pi-do agent notes

- Generate the codebase summary with `bunx repomix --ignore "node_modules/**,bun.lock"`. `repomix` is not installed globally; always run it through `bunx`. Delete `repomix-output.xml` when done.
- Run tests with `bun test`. Pi loads `src/index.ts` directly; no build step.
