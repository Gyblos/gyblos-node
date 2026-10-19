# Contributing to gyblos-payments

## File layout

Every `.ts` file follows this order:

1. **Imports**, in four groups separated by a blank line (sorted automatically by `pnpm format`):
   1. `node:*`
   2. external packages
   3. `@gyblos/*`
   4. relative (`./`, `../` within the same package only)
2. **File-local constants** (`UPPER_SNAKE_CASE`). Anything used by more than one file lives in `@gyblos/config` or in its package's `constants.ts`.
3. **Types and interfaces.**
4. **Private helpers.**
5. **Exported functions.**
6. **`main()`** at the bottom for entrypoints. Signal handlers, timers and mutable state are created inside `main()`, never at import time.

## Constants

- No magic values: hosts, ports, paths, network IDs, program IDs, commitments, versions, timeouts, limits and HTTP statuses come from `@gyblos/config`.
- Versions are read from `package.json` or the lockfile, never typed by hand.
- Model and generation parameters live in `@gyblos/inference-ollama/constants.ts`; prices and tolerance in `@gyblos/application/constants.ts`.

## Packages and boundaries

- Import other packages by name (`@gyblos/gate`), never with `../../../packages/...`.
- `scripts/` contains thin entrypoints only. Nothing in `apps/` or `packages/` imports from `scripts/`.
- Inference adapters know nothing about wallets; payment code knows nothing about engines.

## Size and naming

- Files stay under ~300 lines; split by responsibility (`cases`, `reconcile`, `evidence`, `assertions`).
- Descriptive names: `config`, not `c`; `depositSignature`, not `sig`.
- No `any`. Evidence and journal records have explicit types.

## Commits and checks

- Each commit builds and passes `pnpm typecheck`, `pnpm test` and `pnpm lint` on its own.
- Behavior changes and refactors go in separate PRs.
- Never commit keys, salts, prompts or responses; `.local/` stays ignored.

Current publication exception: tests, evidence, measurements, agent files and internal documents remain outside Git by project-owner instruction. A clean clone therefore does not currently include a `pnpm test` script or acceptance suite. Maintainer runs use the private branch-specific test harness and record results separately. Publishing tests or restoring a public test command requires a separate publication decision. README and this guide are the public documentation exceptions.
