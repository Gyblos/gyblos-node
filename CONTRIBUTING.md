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
- Never commit real private keys, measurement salts, or private prompts/responses; `.local/` stays ignored. Synthetic test inputs, ephemeral test material and public model-template fixtures are permitted.

The offline regression suites and their public fixtures are versioned and run with `pnpm test`. The suite uses synthetic inputs, ephemeral unfunded signers, mocked RPC and temporary files; it does not require wallets, Ollama, Python or devnet funds. `tooling/test-files.json` lists every published suite; the runner rejects missing or unlisted files.

Raw evidence, measurements, agent files and internal documents remain outside Git. The explicitly authorized, allowlisted redacted P2P report `evidence/gate-0006.json` is the evidence exception; never publish raw role volumes, endpoint addresses, signed payloads or content. README, this guide, and the operational guides `docs/inference.md` and `docs/limitations.md` are the public documentation exceptions. The error-code regression belonging to the unpublished error-code change remains separate until that implementation is integrated.
