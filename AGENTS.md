# Gyblos node application

## Repository and scope

- GitHub repo `Gyblos/gyblos-node`; the local checkout directory is still named `gyblos-payments`. It holds the node, buyer, desktop and discovery index applications, not the landing website in `../gyblos` (`web-gyblos`).
- Use English for repository content, comments, commits and PRs; conversation language follows the founder.
- This file is the single public source of agent rules. `CLAUDE.md` imports it and `CONTRIBUTING.md` points here. Detailed style is in [docs/code-standards.md](docs/code-standards.md); Claude Code skills in `.claude/skills/` add procedures, never rules. Optional personal notes go in ignored `AGENTS.local.md`.

## Layers and ownership

Dependency direction is protocol → core → adapters → node → apps; config and runtime are shared support above protocol. Package table: [docs/architecture.md](docs/architecture.md).

- `packages/protocol`: wire contracts, canonical JSON, signing domains and golden vectors (`vectors/`). v1 signed offers and public records plus v2 (`public-v2`, `offer-v2`, `control-*`, `vectors/control-v2.json`). Only v1 is paid; v2 is not wired into payment ([SPEC.md](packages/protocol/SPEC.md)). It also owns the ports plugins implement (`Engine` in `engine.ts`; `PaymentClient`/`PaymentServer` in `payment.ts`, with the shared contract in `tests/support/payment-contract.ts`, not yet implemented by any adapter) and catalogs shared across layers (node roles, engine kinds, pricing kinds, engine error codes). No SDKs.
- `packages/core`: pure policy (metering, offer trust `offers`, `control-admission`, `control-quotes`, `seller-selection*`). No SDKs, filesystem, or clock/random of its own.
- Adapters (plugins) are the packages matching `payments-*`, `identity`, `engine-*`, `transport-*`, `discovery-*`, `telemetry-*` (`tooling/boundaries/config.ts`). Each implements a port and is chosen by composition in `node`; they never import each other, `node` or apps. Inference knows no wallets; payment code knows no engines.
- `packages/node`: local-node library for both roles; composes adapters, including the seller's free channels and control service. Paid selling is off in the daemon until phase 2.
- `apps/node` (seller daemon and the `gyblos` CLI), `apps/buyer`, `apps/desktop` (Electron, the provisional desktop host per vault GYB-DOC-001) and `apps/discovery-index` (the discovery index Cloudflare Worker; deploy needs founder approval) are independent executables; apps never import each other.
- `packages/config`: operator values; `config/src/home.ts` is the only owner of local paths. `packages/runtime`: platform helpers.
- `lab/`: validation outside product (`harness`, `facilitator`, `tools`; `evidence` is historical). "Gate" is a lab word only: no product code, route, variable, message or product script uses it.
- Product never imports `lab/`, `tests/` or `tooling/`. Import other workspaces by name through explicit `exports`; relative imports stay inside one package.
- No import-time initialization: handlers, timers and state start in lifecycle/entry functions (`tests/entrypoint-inertness.test.ts`).

## Commands

Node 22+ and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check          # typecheck + lint + test:all; run before every PR
pnpm typecheck      # includes tests and the desktop renderer
pnpm lint           # eslint + prettier --check + tooling:test + boundaries
pnpm test           # product suites tests/*.test.ts (the PR gate)
pnpm test:lab       # lab suites tests/lab/
pnpm tooling:test   # boundary checker and lint rule tests
pnpm format         # prettier --write, sorts imports
pnpm desktop:build  # also desktop:start, desktop:smoke, desktop:package
```

None of these needs a funded wallet, engine or Docker. `gate:*`, funding, identity devnet and deployment commands are operational actions: never run them to validate a change. A 402 or local test is not proof of an on-chain paid run.

## Hard rules

- Boundaries and lint errors are enforcing; never suppress, baseline or cast around them. Lint warnings must not grow.
- One canonical definition per owned discrete value (`as const` in the owning `constants.ts`, type derived from it); for example use `INFERENCE_EVIDENCE_CODES.ASSERTION_FAILED`, never a second `'ASSERTION_FAILED'` literal. Details: [docs/code-standards.md](docs/code-standards.md).
- No `any`, no widening closed types to `string`, no object-literal `as`, no floating promises, one declaration per `const`/`let`. Parse external input as `unknown` and validate at the boundary.
- Keep behavior changes and structural moves in separate PRs; no scope expansion during structural work. Refactors preserve wire values, test names and counts, journals and private paths. Move files with `git mv` and check ignore rules for the destination.

## Tests

- Every behavior change starts with a failing test (red), then the fix (green); report both runs. TDD is mandatory for confirmed bugs.
- Report exact passed/failed/cancelled/skipped counts for product, lab and tooling separately. A skipped native case proves nothing.
- Tests use public package entries and explicit `void test(...)` registration, and run in a temporary directory with a temp `GYBLOS_HOME`/`GYBLOS_LAB_HOME`. Golden vectors protect signing domains, canonical bytes and error codes. See [tests/README.md](tests/README.md).

## Safety and privacy

- Never read or write a real `.local/` (keys, journals, offers, measurements); never access existing keys, make payments, touch funded wallets, use devnet, deploy, access a VPS or send messages without explicit authorization for that action.
- Uncertain payments block further calls until reconciled; never retry or clear a journal or lock to make something pass.
- Never commit private keys, salts, prompts/responses, raw logs, endpoint addresses, signed payment payloads, RPC credentials, role volumes or journals. `.local/`, env secrets, evidence and captures stay ignored; the curated `lab/evidence/` reports and the finalized public fixture are deliberate exceptions. Synthetic fixtures and ephemeral unfunded signers are fine. Review the staged diff before publishing.

## Workflow and merges

- Small coherent commits; never rewrite pushed commits without authorization.
- Every substantive PR gets three independent read-only reviews (structure, behavior equivalence, security), each in its own worktree; one writer fixes confirmed findings and re-runs the gates.
- PRs are merged with merge commits, never squash (GYB-DOC-024, amended 2026-10-23).
- Opening a PR or green CI never authorizes a merge; merge only on explicit founder approval for that PR. CI (`.github/workflows/ci.yml`) runs the offline checks on every PR and push to `main`. It runs on Linux only; the macOS/Windows wallet and backup-exchange jobs are manual (`desktop-platforms.yml`), so run them before desktop distribution or after wallet/backup/restore changes.
- Procedures and reviewer templates: `.claude/skills/gyblos-pr-workflow/SKILL.md`.

## Worktrees

- Work in your own detached worktree, never in a shared checkout or another agent's worktree.
- Sub-agents never delete their worktree or branch; report the path to the parent. The main agent asks before removing a worktree it is in, and from the repository root removes only worktrees it launched.

## Vault and decisions

- Product docs, research and decisions live in `../gyblos-brain`. Before planning, read its `AGENTS.md`, `Home.md`, `20 Decisions/Decision log.md` and `40 Validation/Self-improvement.md`, and follow that procedure there (search before creating notes, no new folders or categories, no automations or permission changes). Verify the target note before editing. Never touch `.obsidian`.
- After meaningful merged work, update `30 Repos/gyblos-payments.md` (the gyblos-node note; legacy file name) per the vault's `AGENTS.md`: versioned, local commit only, no push without approval. Repository docs carry no PR numbers or run history.
- Decisions: GYB-DOC-024 repository architecture and GYB-DOC-009 token/reputation/no-KYC (decided); GYB-DOC-022 discovery, GYB-DOC-028 reasoning levels, GYB-DOC-029 buyer router, GYB-DOC-030 network metrics, GYB-DOC-026 install/config (proposed). Do not change confirmed decisions.
