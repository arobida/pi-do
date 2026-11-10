# Contributing to pi-do

Issues and pull requests are welcome. Keep changes small and covered by tests.

## Tech stack

- TypeScript (ESM), loaded directly by Pi — no build step.
- [Bun](https://bun.sh) for development, tests, and packaging.
- Peer dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.

## Project structure

```
src/index.ts            Extension entry point: tool, commands, shortcuts, widget, backends
test/extension.test.ts  Bun test suite
CHANGELOG.md            Release notes
```

## Local development

```sh
bun install
bun test
bun run pack:check
pi install "$PWD"
```

Run `/reload` in Pi after source changes. Pi loads `src/index.ts` directly; no build step is required. Install this package only once; remove any standalone `dex-panel.ts` copy first.

Generate a codebase summary for agents with `bunx repomix --ignore "node_modules/**,bun.lock"` (repomix is not installed globally). Delete `repomix-output.xml` when done.

Note the package has no license yet (see Publishing); contributions land under whatever license the first release chooses.

## Publishing

The Pi manifest and `pi-package` keyword are included. Before the first release, confirm npm name availability (or choose a scope), choose a license, add repository metadata, and review the tarball with `bun run pack:check`. Then publish with `bun publish`. Nothing is published automatically.
