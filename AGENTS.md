# Gyblos node application

This repository contains the Gyblos node and buyer application, not the separate landing website in `../gyblos` (`web-gyblos`). Use English for repository content, comments, commits and pull requests; conversation language follows the founder.

## Package map and purpose

- `packages/protocol`: SDK-independent signing, canonical bytes, engine contracts, shared error taxonomy and public discovery records (see `SPEC.md`).
- `packages/core`: workflow and metering policy; no SDKs, filesystem or adapters.
- `packages/engine-ollama`, `payments-x402`, `transport-iroh`, `identity` (8004 registry; not wired yet): independent adapters.
- `packages/node`: seller composition and lifecycle, plus role keys and signed offers shared with `apps/buyer`.
- `apps/node` (seller daemon), `apps/buyer` (proxy, paid call, measurements, synthetic cases, reconciliation), `apps/facilitator`: independent executable applications.
- `packages/config`: operator configuration and values shared by product packages (gate-only paths and endpoints live in `lab/harness`); `runtime`: platform support.
- `lab/harness` (gate checks, x402 `exact` scheme, fixed-price test seller, gate runner), `lab/tools`, `lab/evidence`: validation and experiments, outside product ownership. The Docker/NAT laboratory is archived at tag `archive/poc-lab-2026-10`.
- `tests` and `tooling`: offline verification; no import-time application initialization.

## Documentation

User-facing docs: `README.md` (short entry point) and topical pages in `docs/`. Keep them current and short; no PR numbers, merge status or run history (that belongs in the vault).

## Vault context

Product documentation, research, decisions and design live in `../gyblos-brain`. Before planning or documenting, read its `AGENTS.md`, `Home.md`, `20 Decisions/Decision log.md`, and `40 Validation/Self-improvement.md`, in that order, then the relevant spec, DESIGN and existing task notes. Follow that procedure there rather than copying it into this repository. Verify the active repository and target note before editing; landing paths and commands are not instructions for this app.

Search titles, aliases and content before creating a note; extend an existing relevant note. Never create vault categories, folders, subfolders or structural indexes without explicit approval. Apply its self-improvement cycle and independent read-only reviews for substantive changes. Do not change confirmed decisions, expand permissions or create automations. Keep `30 Repos/gyblos-payments.md` (the stable vault note for gyblos-node; the file name is the legacy repository name) current after meaningful merged work, version and locally commit authorized vault changes, and do not push the vault without approval. Never touch `.obsidian`.

## Commands

Use Node 22 or later and the pinned pnpm version in package.json.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:lab
pnpm boundaries
pnpm format
```

These checks require no funded wallet, real engine or Docker. Native tests require the pinned binding and IPv6 loopback; explicit skips establish no native result. Gate, funding and diagnostic/deployment commands are separate operational actions: do not execute them merely to validate a refactor. A 402 or local test is not proof of an on-chain paid gate.

## Architecture rules

Dependency direction is protocol → core → independent adapters → node → apps. Config/runtime may be consumed above protocol. Product must never import lab, tests or tooling; distinct adapters and distinct apps must not import each other. Tests and lab may exercise public package entries. Import other workspaces by name and only explicit exports; use relative imports within the same package. Inference knows no wallets; payment code knows no engines. Boundaries are enforcing; do not suppress violations.

## Canonical values and derived types

- Application-owned discrete values shared by runtime behavior and type contracts (including error codes, evidence fallbacks, statuses and case identifiers) must have one canonical definition as named constants or an `as const` catalog in the owning package's `constants.ts`.
- Derive the corresponding types from those values using `typeof`, indexed access or `keyof`. Runtime producers, comparisons and assertions import the constants; type declarations import the derived type or reference the canonical member type. TypeScript types are erased and do not supply runtime values.
- Do not repeat the raw string in a type union and its runtime uses. An inline literal union is type-safe, but does not satisfy the single-source requirement. This also applies when there is only one runtime producer: the producer and its evidence/type declaration already share a contract.
- For example, define `INFERENCE_EVIDENCE_CODES.ASSERTION_FAILED` once, derive its type, and use the imported member when recording an assertion failure. Do not independently write `'ASSERTION_FAILED'` in the evidence union and the catch handler.
- Keep ownership boundaries: evidence diagnostics belong to the gate/evidence package; payment errors belong to the payments package. Do not widen a closed contract to `string` or use casts/`any` to bypass it.
- Search for existing canonical values before adding definitions. Reuse configured paths and domain constants; do not borrow a constant from an unrelated concept merely because its current value matches (for example, an HTTP status is not a character limit).
- Raw literals remain appropriate in the canonical definitions, descriptive messages, genuinely private values without a shared contract, and external Node/SDK/protocol identifiers without an exported canonical value. Prefer an upstream exported constant when one exists; do not copy an external error catalog into an application-owned union.
- Valid typed test inputs and contract-selection predicates use canonical members. Independent expected wire values, intentionally invalid inputs and raw external/historical boundary fixtures may remain literal so tests can detect contract changes. Do not use casts to hide invalid owned contract values in valid fixtures.
- Apply this rule to new or modified contracts and check their producers, types, comparisons and assertions together. Existing code is not automatically migrated by this instruction; report remaining gaps accurately.

## Style guide

Start each TypeScript module with a 1–3 line header describing its responsibility and the boundary it must not cross. Keep functions focused on one named step, with a warning at 80 lines; file length warns at 400 lines. Use descriptive names; `i` and `tx` are permitted. New code is TypeScript, not MJS.

Use four import groups separated by blank lines: node builtins, external packages, @gyblos packages, then relative imports. `pnpm format` sorts them. Keep declarations near their use; there is no declaration-order rank. Create handlers, timers and mutable application state inside lifecycle/entry functions, never on import.

```ts
// Do: preserve order and give each declaration a name.
const request = prepareRequest();
const ceiling = priceRequest(request);
// Avoid: const r = prepareRequest(), c = priceRequest(r);
```

Use one declaration per const/let. Name operational values in the owning module or its constants.ts; config is for operator-changeable values, not a dumping ground for unrelated constants. Retained legacy fixed config values need not be moved during unrelated work. Dependency versions come from manifests/lockfile. Do not add any, widen closed types to string, or cast invalid owned values to bypass checks.

## Errors and external boundaries

New package errors use typed codes from their owning catalog; plain Error belongs in executable CLI boundaries. Existing uncoded errors and legacy parsing retain their behavior until a separately reviewed behavior change; this migration does not claim they were all converted. Preserve external SDK error identity and propagation.

Parse external JSON as unknown, then validate shape, bounds and trust at the boundary. Prefer a typed variable or satisfies for constructed objects, never an object-literal `as` cast. A TypeScript annotation/assertion is not runtime validation. Existing legacy parsing remains explicit debt; do not silently tighten accepted input or change error precedence during a refactor. Await promises or return them; use void only for intentionally detached work whose existing error semantics are understood. Do not swallow errors to satisfy lint.

## Testing

Run typecheck, lint and the discovered offline tests for every PR. `pnpm test` is the product gate (`tests/*.test.ts`); `pnpm test:lab` runs lab-only regressions in `tests/lab/` and must also pass when lab code changes; `pnpm test:all` runs both; `pnpm tooling:test` (`tooling/**/*.test.ts`, also run by `pnpm lint`) tests the boundary checker and lint rules. Report exact passed, failed, cancelled and skipped counts; distinguish tooling tests from product tests. Use public package entries. See [tests/README.md](tests/README.md) for native prerequisites, opt-in integration and the fixtures policy. Keep explicit `void test(...)` registration; deliberately invalid boundary data and partial SDK doubles may use assertions in tests, never in product code. TDD is required for confirmed behavior bugs; keep behavior changes and moves in separate PRs. Golden vectors protect signing domain, canonical bytes and error code values. Refactors preserve existing test names/counts, wire values, journals and private paths; explain any new test registration.

## Security and privacy

Never commit real private keys, measurement salts, private prompts/responses, raw logs, endpoint addresses, signed payment/voucher payloads, RPC credentials, role volumes or operational journals. `.local`, env secrets, evidence and captures stay ignored. The three curated reports in `lab/evidence/` and the finalized public transaction fixture are deliberate exceptions; do not expand them casually. Public docs/tests are tracked by default with a privacy denylist. Synthetic fixtures and ephemeral unfunded signers are permitted. Review the staged diff, including formerly ignored paths, before publication.

Never access existing keys/journals, make payments, touch funded wallets, deploy, access a VPS or send messages without authorization for that action. Uncertain payments stop subsequent calls and require reconciliation; never retry or clear a journal to make a test pass.

## Git and PRs

Use small coherent commits; GYB-DOC-024 replaces the former one-file-per-commit convention. Do not rewrite existing commits without explicit authorization. Squash is the default merge convention unless the founder requests otherwise. Keep behavior changes and structural refactors in separate PRs. Each PR passes typecheck, lint and test; compare counts and move tracked files with git mv, checking ignore rules and tracked destinations. Run three read-only reviews (structure, equivalence, security) for migration stages; one writer resolves confirmed findings. Opening a PR does not authorize merging unless the current task does. No scope expansion, deployments or paid gates during structural work.

## Worktrees

- Sub-agents must never delete their worktree; report its path to the parent.
- If the main agent's current directory is a worktree, ask for confirmation before removing it.
- From the repository root, the main agent may clean up only worktrees it launched.

## Decision references

- GYB-DOC-024: decided repository architecture and staged migration.
- GYB-DOC-022: proposed discovery; not implemented by this restructure.
- GYB-DOC-009: decided token/reputation/no-KYC policy; no changes implied here.
- GYB-DOC-026: proposed installation/configuration; separate future work.

Optional personal instructions belong in ignored AGENTS.local.md. This file is the public single source; CLAUDE.md imports it and CONTRIBUTING.md points here.
