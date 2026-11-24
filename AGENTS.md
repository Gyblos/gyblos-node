# Gyblos node application

## Repository and scope

- GitHub repo `Gyblos/gyblos-node`; the local checkout directory is still named `gyblos-payments`. It holds the node, buyer, desktop and discovery index applications, not the landing website in `../gyblos` (`web-gyblos`).
- Use English for repository content, comments, commits and PRs; conversation language follows the founder.
- This file is the single public source of agent rules. `CLAUDE.md` imports it and `CONTRIBUTING.md` points here. Detailed style is in [docs/code-standards.md](docs/code-standards.md); the shared contributor workflow is in [CONTRIBUTING.md](CONTRIBUTING.md). Repository skills are canonical in `.agents/skills/` and mirrored to `.claude/skills/`, adding procedures but never rules. Optional personal notes go in ignored `AGENTS.local.md`.

## Layers and ownership

Dependency direction is protocol → core → inference/adapters → node → apps; config and runtime are shared support above protocol. Package table: [docs/architecture.md](docs/architecture.md).

- `packages/protocol`: wire contracts, canonical JSON, signing domains and golden vectors (`vectors/`). It owns v1 signed offers and v2 public records, control, offers and reusable payment channels. The seller composes payment sessions for priced offers; see [limitations](docs/limitations.md) for validation scope. It also owns plugin ports (`Engine`, `PaymentClient` and `PaymentServer`), payment binding and shared catalogs. No SDKs.
- `packages/core`: pure policy (metering, offer trust `offers`, `control-admission`, `control-quotes`, `seller-selection*`). No SDKs, filesystem, or clock/random of its own.
- Adapters (plugins) are the packages matching `payments-*`, `identity`, `engine-*`, `transport-*`, `discovery-*`, `telemetry-*` (`tooling/boundaries/config.ts`). Each implements a port and is chosen by composition in `node`; they never import each other, `node` or apps. Inference knows no wallets; payment code knows no engines.
- Standalone packages (`STANDALONE_NAMES` in `tooling/boundaries/config.ts`) are meant to leave the monorepo under their own license: they import no workspace package, app, lab or test code, keep their tests in `packages/<name>/test/`, and only `payments-*` adapters (plus tests and tooling) may import them.
- `packages/inference`: shared SDK-free inference orchestration over protocol ports and core policy. It imports no concrete adapters, node or apps; core and adapters do not import it. Node supplies the engine, economic policy and observation ports.
- `packages/node`: local-node library for both roles; composes adapters, including seller control, free channels and reusable payment channels for priced offers.
- `apps/node` (seller daemon and the `gyblos` CLI), `apps/buyer`, `apps/desktop` (the desktop app: Electron, the provisional desktop host), `apps/discovery-index` (the discovery index Cloudflare Worker; deploy needs founder approval), `apps/metrics-collector` (the metrics collector: the public receipt Cloudflare Worker at collector.gyblos.com, with scheduled aggregates and a public stats API; migrations and deploys need founder approval), `apps/docs` (the public docs site, docs.gyblos.com: a Fumadocs static export; publishing needs founder approval), `apps/explorer` (the public metrics explorer at explorer.gyblos.com: a server-rendered Next.js app over the discovery index, the metrics collector's stats API and Solana; deploys need founder approval. Its reusable components live in `components/board` and are published as a shadcn registry, `registry.json` built into `/r/<name>.json`, so other Gyblos apps install them with `npx shadcn add https://explorer.gyblos.com/r/<name>.json`) `apps/receipt-collector` (the local receipt receiver: a standalone loopback-only process) and `apps/model-verifier` (checks, as an external buyer of free offers, that a seller serves the model it declares; it never imports buyer, node or desktop code) are independent executables; apps never import each other. Every docs page has an English and a Spanish file, updated together; a change to output the seller guide quotes updates the guide in the same PR (`tests/docs-content.test.ts`).
- A change to how the product is used (seller or buyer commands and flags, public routes, public data, privacy, seller or buyer steps) updates the repository `docs/` and the docs site, English and Spanish, in the same PR; when new data becomes public, that includes `reference/data-and-privacy`. Contributor and operator procedures (migrations, deploys, admin scripts, repository tooling) go in `docs/` only, never on the docs site.
- Buyers use the desktop app, and the API keys it issues to connect their coding tools. Public buyer-facing text (the docs site, the landing in `web-gyblos`, desktop copy) never tells a buyer to clone this repository, install Node or pnpm, or run `pnpm buyer` / `buyer:*` scripts. Running the buyer from a checkout is contributor material and belongs only in `docs/`.
- `packages/config`: operator values; `config/src/home.ts` is the only owner of local paths. `packages/runtime`: platform helpers.
- `lab/`: validation outside product (`harness`, `tools`; `evidence` is historical). "Gate" is a lab word only: no product code, route, variable, message or product script uses it.
- Product never imports `lab/`, `tests/` or `tooling/`. Import other workspaces by name through explicit `exports`; relative imports stay inside one package.
- Dependency patches are a last resort: each lives in `patches/` (pnpm `patchedDependencies`), changes nothing unless explicitly used, is justified next to its entry in `pnpm-workspace.yaml` with its upstream status, and is removed when the dependency supports the change.
- D1 migrations (`apps/discovery-index`, `apps/metrics-collector`) are generated with drizzle-kit from `schema.ts` (`pnpm index:db:generate` / `pnpm collector:db:generate`); never write migration SQL by hand, never edit an applied migration, and apply remotely only with founder approval. The single exception is a reviewed data-only change (UPDATE/DELETE/backfill), created with `--custom --name <change>` and holding only data statements. Never run drizzle-kit `push`, `pull` or `introspect` against D1. Details: [docs/code-standards.md](docs/code-standards.md#d1-migrations).
- No import-time initialization: handlers, timers and state start in lifecycle/entry functions (`tests/entrypoint-inertness.test.ts`).

## Commands

Node 24.22.1+ and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check          # typecheck + lint + test:all; run before every PR
pnpm typecheck      # includes tests and the desktop renderer
pnpm lint           # eslint + comments:check + typescript:check + prettier --check + tooling:test + skills:check + boundaries + db:check
pnpm test           # product suites tests/*.test.ts and packages/*/test (required checks)
pnpm test:lab       # lab suites tests/lab/
pnpm tooling:test   # boundary checker and lint rule tests
pnpm format         # prettier --write, sorts imports
pnpm desktop:build  # also desktop:start, desktop:smoke, desktop:package
```

None of these needs a funded wallet, engine or Docker. `gate:*`, funding, identity devnet and deployment commands are operational actions: never run them to validate a change. A 402 or local test is not proof of an on-chain paid run.

## Shared contributor workflow

- Humans and AI-assisted contributors follow the same change loop: orient, define scope, inspect, implement, verify locally, review and hand off. The procedure is [`.agents/skills/gyblos-contributor-workflow/SKILL.md`](.agents/skills/gyblos-contributor-workflow/SKILL.md); its public onboarding explanation is [CONTRIBUTING.md](CONTRIBUTING.md#using-ai-tools).
- Provider-specific files may help a tool load this repository, but they do not add rules or replace project context. A handoff must be reproducible from the branch, repository files and reported checks, without a private prompt or transcript.

## Writing code

- State your assumptions before coding. When readings of a request lead to different behavior or scope, ask the founder or a maintainer; otherwise state your choice and continue. When a simpler approach exists, say so.
- Write the least code that solves the request: no features, options or abstractions nobody asked for. Validation at trust boundaries, error handling for external input, the diagnostics Safety and privacy requires and security controls are always in scope (see Hard rules and Safety and privacy).
- Keep changes surgical: every changed line traces to the request; match the surrounding style and do not reformat, rename or refactor neighboring code. A replacement removes the old path in the same PR (Hard rules: delete code no product path uses). Report, without fixing, unrelated unused code and any security or correctness defect you notice; fix one only when it blocks the request.
- Define the check that proves a task is done before you start; for a behavior change that check is the failing test required under Tests.

## Hard rules

- Boundaries and lint errors are enforcing; never suppress, baseline or cast around them. Lint warnings must not grow.
- Source comment budgets are exact per file; a changed file may not gain a comment whose text is not in the base.
- One canonical definition per owned discrete value (`as const` in the owning `constants.ts`, type derived from it); for example use `INFERENCE_EVIDENCE_CODES.ASSERTION_FAILED`, never a second `'ASSERTION_FAILED'` literal. Details: [docs/code-standards.md](docs/code-standards.md).
- Never add a `.mjs`, `.cjs` or `.js` file: JavaScript-family code is always TypeScript, including scripts, tooling and configuration. Rust sidecars follow [docs/stack.md](docs/stack.md#when-to-use-rust).
- No `any`, no widening closed types to `string`, no object-literal `as`, no floating promises, one declaration per `const`/`let`. Parse external input as `unknown` and validate at the boundary.
- Delete code no product path uses: when a replacement is ready, remove the old path with its tests, scripts, docs and workspace entries instead of keeping it "for compatibility". Reachability from product entry points (seller daemon and `gyblos` CLI, buyer commands, desktop, Workers) decides; a test, lab gate or doc that is its only user does not keep it alive. This applies to every app and package.
- Paid inference uses payment channels (payment sessions) only. Never add a new per-request payment path.
- Keep behavior changes and structural moves in separate PRs; no scope expansion during structural work. Refactors preserve wire values, test names and counts, journals and private paths. Move files with `git mv` and check ignore rules for the destination.

## Tests

- Every behavior change starts with a failing test (red), then the fix (green); report both runs. TDD is mandatory for confirmed bugs.
- Report exact passed/failed/cancelled/skipped counts for product, lab and tooling separately. A skipped native case proves nothing.
- Tests use public package entries and explicit `void test(...)` registration, and run in a temporary directory with a temp `GYBLOS_HOME`/`GYBLOS_LAB_HOME`. Golden vectors protect signing domains, canonical bytes and error codes. See [tests/README.md](tests/README.md).

## Safety and privacy

- Operational diagnostics are separate from telemetry and receipts. Use the shared runtime diagnostic envelope and owner-owned code/phase catalogs at new or changed failure boundaries; never serialize an exception, request, response, credential or arbitrary error message. See [docs/diagnostics.md](docs/diagnostics.md).
- Preserve the primary failure; record cleanup failures separately. Diagnostic failure, queue overflow or storage exhaustion must never change admission, payment, retry, cancellation or deadline behavior. Diagnostics are bounded local evidence, not a guarantee that every failure survives a crash.
- Test diagnostic privacy and failure isolation with synthetic canaries and temporary homes. Keep captures ignored and report the failing phase and evidence limits when investigating a flaky test. The shared procedure is [gyblos-diagnostics](.agents/skills/gyblos-diagnostics/SKILL.md).

- Never read or write a real `.local/` (keys, journals, offers, measurements); never access existing keys, make payments, touch funded wallets, use devnet, deploy, access a VPS or send messages without explicit authorization for that action.
- Uncertain payments block further calls until reconciled; never retry or clear a journal or lock to make something pass.
- Never commit private keys, salts, prompts/responses, raw logs, endpoint addresses, signed payment payloads, RPC credentials, role volumes or journals. `.local/`, env secrets, evidence and captures stay ignored; the curated `lab/evidence/` reports and the finalized public fixture are deliberate exceptions. Synthetic fixtures and ephemeral unfunded signers are fine. Review the staged diff before publishing.

## Desktop visual changes

- Work on desktop UI proposals in the isolated web mockup first. Use the current renderer and shared components, with synthetic data and the approved brand kit; keep proposal-only styles and artwork outside the shipped desktop renderer.
- Open the web preview and visually review all seven screens at wide and narrow widths, including both themes, interactions and relevant states. Show the result to the founder and wait for explicit approval of that visual proposal before porting it to the desktop app.
- A request to change, preview, save, push or open a PR for the mockup does not authorize desktop implementation. Approval to implement an earlier proposal does not carry over to later visual changes.
- After explicit approval, port the accepted shared design to the desktop app and compare it against the approved web preview at the same viewport size. Do not consider a successful build a visual review. Record remaining differences and validation limits in the PR.
- In the web mockup (`lab/tools/desktop-preview`), reuse the shared components listed in the Components table of its `DESIGN.md` instead of writing raw markup; a new reusable component is added to that table in the same change. Shipped desktop code follows `apps/desktop/DESIGN.md` until a port is approved. Procedure: [gyblos-desktop-ui](.agents/skills/gyblos-desktop-ui/SKILL.md).
- Keep the workflow and component rules aligned with `apps/desktop/DESIGN.md`. This root file remains the single public agent-instruction source; do not add a conflicting desktop-specific agent file.

## Workflow and merges

- Small coherent commits; never rewrite pushed commits without authorization.
- Review each substantive PR with a team of three independent read-only agents covering structure, behavior equivalence and security. Each reviewer works in a separate detached worktree at the PR head and reports findings with evidence.
- One writer verifies each finding. For every confirmed bug, first add a regression test and observe it fail for the reported reason, then fix the bug and run the test again. Resolve confirmed findings before handoff and record the reasoning for any dismissed finding. Re-run the required checks, have the team verify the final head, and include the red and green results and reviewer verdicts in the PR.
- PRs are merged with merge commits, never squash.
- Branches: work lands in `develop`; open every PR against `develop`. `main` receives only release PRs from `develop`, and release tags are cut from `main`. Both branches are protected: changes arrive only through PRs, with merge commits.
- Opening a PR or green CI never authorizes a merge; merge only on explicit founder approval for that PR. CI, Security and Static analysis run on PRs into `develop` or `main` and on pushes to them. A stacked child PR intentionally has no hosted run: it still requires exact-head local gates, three independent reviews and separate founder approval before merging into its base. Merge stacks top-down; the final PR into `develop` requires successful current checks on the combined head. A missing or filtered check is never a passing check. Head updates and the final push to `develop` can run checks again. Default CI uses Linux plus targeted Windows checks; the broader wallet and backup-exchange platform jobs are manual (`desktop-platforms.yml`), so run them before desktop distribution or after wallet/backup/restore changes. A local-only task does not authorize triggering or rerunning remote workflows; report them as not run and leave the PR open.
- Procedures and reviewer templates: `.agents/skills/gyblos-pr-workflow/SKILL.md`.

## Worktrees

- Work in your own detached worktree, never in a shared checkout or another agent's worktree.
- Sub-agents never delete their worktree or branch; report the path to the parent. The main agent asks before removing a worktree it is in, and from the repository root removes only worktrees it launched.

## Founder decisions

- Windows, macOS and Linux get the same features. Close a platform gap (for example payment-folder permissions on Windows) instead of shipping less on one platform.
- Payment sessions default to a 1 USDC deposit (`1000000` atomic) and a 1-hour lifetime (`3600000` ms).
- Keep `telemetry-file`, `telemetry-otel` and PayPal unless the founder approves removing them.

## Public decisions and internal vault

- Contributors can work from the public repository without access to the private vault. Start with [docs/public-decisions.md](docs/public-decisions.md); if a decision needed for a change is missing or unclear, ask maintainers rather than inventing a policy. Do not change confirmed decisions without approval.
- Gyblos maintainers and agents with authorized access to `gyblos-brain` continue using it for product research, decisions and internal records. Before planning, read its `AGENTS.md`, `Home.md`, `20 Decisions/Decision log.md` and `40 Validation/Self-improvement.md`, and follow its procedures. Never touch `.obsidian`.
- After meaningful merged work, an authorized maintainer updates `30 Repos/gyblos-payments.md` in the vault per its `AGENTS.md`: versioned, local commit only, no push without approval. Contributors without access are not responsible for this update. Repository docs carry no PR numbers or run history.
- Maintainers keep public decisions and contracts aligned with confirmed vault decisions; review proposed public text for sensitive information and do not publish private notes wholesale. When sources conflict, flag the discrepancy for a maintainer instead of silently choosing a policy.
