# Gyblos node application

## Repository and scope

- GitHub repo `Gyblos/gyblos-node`; the local checkout directory is still named `gyblos-payments`. It holds the node, buyer, desktop and discovery index applications, not the landing website in `../gyblos` (`web-gyblos`).
- Use English for repository content, comments, commits and PRs; conversation language follows the founder.
- This file is the single public source of agent rules. `CLAUDE.md` imports it and `CONTRIBUTING.md` points here. Detailed style is in [docs/code-standards.md](docs/code-standards.md); the shared contributor workflow is in [docs/ai-assisted-contributing.md](docs/ai-assisted-contributing.md). Repository skills are canonical in `.agents/skills/` and mirrored to `.claude/skills/`, adding procedures but never rules. Optional personal notes go in ignored `AGENTS.local.md`.

## Layers and ownership

Dependency direction is protocol → core → adapters → node → apps; config and runtime are shared support above protocol. Package table: [docs/architecture.md](docs/architecture.md).

- `packages/protocol`: wire contracts, canonical JSON, signing domains and golden vectors (`vectors/`). It owns v1 signed offers and v2 public records, control, offers and paid execution (`paid-execution`, `paid-stream`). Paid v2 is conditionally composed by the seller with a payment server; see [limitations](docs/limitations.md) for validation scope. It also owns plugin ports (`Engine`, `PaymentClient` and `PaymentServer`), payment binding and shared catalogs. No SDKs.
- `packages/core`: pure policy (metering, offer trust `offers`, `control-admission`, `control-quotes`, `seller-selection*`). No SDKs, filesystem, or clock/random of its own.
- Adapters (plugins) are the packages matching `payments-*`, `identity`, `engine-*`, `transport-*`, `discovery-*`, `telemetry-*` (`tooling/boundaries/config.ts`). Each implements a port and is chosen by composition in `node`; they never import each other, `node` or apps. Inference knows no wallets; payment code knows no engines.
- Standalone packages (`STANDALONE_NAMES` in `tooling/boundaries/config.ts`) are meant to leave the monorepo under their own license: they import no workspace package, app, lab or test code, keep their tests in `packages/<name>/test/`, and only `payments-*` adapters (plus tests and tooling) may import them.
- `packages/node`: local-node library for both roles; composes adapters, including seller control, free channels and conditional paid-v2 execution when a payment server is supplied.
- `apps/node` (seller daemon and the `gyblos` CLI), `apps/buyer`, `apps/desktop` (Electron, the provisional desktop host per vault GYB-DOC-001) `apps/discovery-index` (the discovery index Cloudflare Worker; deploy needs founder approval) and `apps/docs` (the public docs site, docs.gyblos.com: a Fumadocs static export; publishing needs founder approval) are independent executables; apps never import each other. Every docs page has an English and a Spanish file, updated together; a change to output the seller guide quotes updates the guide in the same PR (`tests/docs-content.test.ts`).
- `packages/config`: operator values; `config/src/home.ts` is the only owner of local paths. `packages/runtime`: platform helpers.
- `lab/`: validation outside product (`harness`, `facilitator`, `tools`; `evidence` is historical). "Gate" is a lab word only: no product code, route, variable, message or product script uses it.
- Product never imports `lab/`, `tests/` or `tooling/`. Import other workspaces by name through explicit `exports`; relative imports stay inside one package.
- Dependency patches are a last resort: each lives in `patches/` (pnpm `patchedDependencies`), changes nothing unless explicitly used, is justified next to its entry in `pnpm-workspace.yaml` with its upstream status, and is removed when the dependency supports the change.
- No import-time initialization: handlers, timers and state start in lifecycle/entry functions (`tests/entrypoint-inertness.test.ts`).

## Commands

Node 24.22.1+ and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check          # typecheck + lint + test:all; run before every PR
pnpm typecheck      # includes tests and the desktop renderer
pnpm lint           # eslint + prettier --check + tooling:test + skills:check + boundaries
pnpm test           # product suites tests/*.test.ts (the PR gate)
pnpm test:lab       # lab suites tests/lab/
pnpm tooling:test   # boundary checker and lint rule tests
pnpm format         # prettier --write, sorts imports
pnpm desktop:build  # also desktop:start, desktop:smoke, desktop:package
```

None of these needs a funded wallet, engine or Docker. `gate:*`, funding, identity devnet and deployment commands are operational actions: never run them to validate a change. A 402 or local test is not proof of an on-chain paid run.

## Shared contributor workflow

- Humans and AI-assisted contributors follow the same change loop: orient, define scope, inspect, implement, verify locally, review and hand off. The procedure is [`.agents/skills/gyblos-contributor-workflow/SKILL.md`](.agents/skills/gyblos-contributor-workflow/SKILL.md); its public onboarding explanation is [docs/ai-assisted-contributing.md](docs/ai-assisted-contributing.md).
- Provider-specific files may help a tool load this repository, but they do not add rules or replace project context. A handoff must be reproducible from the branch, repository files and reported checks, without a private prompt or transcript.

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
- Procedures and reviewer templates: `.agents/skills/gyblos-pr-workflow/SKILL.md`.

## Worktrees

- Work in your own detached worktree, never in a shared checkout or another agent's worktree.
- Sub-agents never delete their worktree or branch; report the path to the parent. The main agent asks before removing a worktree it is in, and from the repository root removes only worktrees it launched.

## Public decisions and internal vault

- Contributors can work from the public repository without access to the private vault. Start with [docs/public-decisions.md](docs/public-decisions.md); if a decision needed for a change is missing or unclear, ask maintainers rather than inventing a policy. Do not change confirmed decisions without approval.
- Gyblos maintainers and agents with authorized access to `gyblos-brain` continue using it for product research, decisions and internal records. Before planning, read its `AGENTS.md`, `Home.md`, `20 Decisions/Decision log.md` and `40 Validation/Self-improvement.md`, and follow its procedures. Never touch `.obsidian`.
- After meaningful merged work, an authorized maintainer updates `30 Repos/gyblos-payments.md` in the vault per its `AGENTS.md`: versioned, local commit only, no push without approval. Contributors without access are not responsible for this update. Repository docs carry no PR numbers or run history.
- Maintainers keep public decisions and contracts aligned with confirmed vault decisions; review proposed public text for sensitive information and do not publish private notes wholesale. When sources conflict, flag the discrepancy for a maintainer instead of silently choosing a policy.
