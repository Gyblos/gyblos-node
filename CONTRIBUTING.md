# Contributing to gyblos-payments

## File layout

Every `.ts` file follows this order:

1. **Imports**, in four groups separated by a blank line (sorted automatically by `pnpm format`):
   1. `node:*`
   2. external packages
   3. `@gyblos/*`
   4. relative (`./`, `../` within the same package only)
2. **File-local constants** (`UPPER_SNAKE_CASE`). Shared configuration lives in `@gyblos/config`; shared domain values live in their owning package's `constants.ts`. The canonical contract rule below also applies to a single runtime producer and its type declaration.
3. **Types and interfaces.**
4. **Private helpers.**
5. **Exported functions.**
6. **`main()`** at the bottom for entrypoints. Signal handlers, timers and mutable state are created inside `main()`, never at import time.

## Constants

- Hosts, ports, paths, network IDs, program IDs, commitments, timeouts, limits and HTTP statuses come from `@gyblos/config`.
- Dependency versions are read from `package.json` or the lockfile. Application-owned schema versions live in the owning package's constants.
- Model and generation parameters live in `@gyblos/inference-ollama/constants.ts`; prices and tolerance in `@gyblos/application/constants.ts`.

### Canonical contract values and derived types

Define application-owned codes, statuses, case identifiers and other discrete
contract values once in the owning package's `constants.ts`. This applies even
when only one runtime producer shares the value with a type declaration.
Derive types from the constants; import the values in producers, comparisons
and assertions. An independently repeated literal union does not satisfy this
rule, because TypeScript types do not provide runtime values.

For example, the payment package owns this catalog and its derived type:

```ts
export const PUBLIC_CALL_OUTCOMES = {
  SUCCESS: 'success',
  REJECTED: 'rejected',
  UNCERTAIN: 'uncertain',
} as const;

export type PublicCallOutcome =
  (typeof PUBLIC_CALL_OUTCOMES)[keyof typeof PUBLIC_CALL_OUTCOMES];
```

Consumers import both from `@gyblos/payments-x402/constants` and assign
`PUBLIC_CALL_OUTCOMES.SUCCESS` to a `PublicCallOutcome`, rather than repeating
the raw value.

- Keep domain ownership: payment errors belong to payments, evidence diagnostics
  to gate, and engine completion reasons to the inference adapter. Matching text
  in unrelated domains does not require one global catalog.
- Keep contracts as narrow as their flow allows. Do not widen them to `string`
  or use casts or `any` to bypass an invalid value. Types do not validate input
  at runtime; preserve boundary checks and rejection of unknown journal states.
- Literals remain appropriate in canonical definitions, descriptive messages,
  private values without a shared contract, and external SDK/Node/protocol
  identifiers without upstream constants. Prefer upstream constants when available.
- Typed test inputs use canonical values. Independent expected wire values and
  intentionally invalid fixtures may remain literals, so tests can detect a
  changed contract or rejected input.
- Review the definition, derived type, producers, comparisons and assertions
  together. Preserve serialized values during refactors; this convention does
  not imply every existing literal has been migrated or is lint-enforced.

## Packages and boundaries

- Import other packages by name (`@gyblos/lab-harness`), never with `../../../packages/...`.
- `scripts/` contains thin entrypoints only. Nothing in `apps/` or `packages/` imports from `scripts/`.
- Inference adapters know nothing about wallets; payment code knows nothing about engines.

## Size and naming

- Files stay under ~300 lines; split by responsibility (`cases`, `reconcile`, `evidence`, `assertions`).
- Descriptive names: `config`, not `c`; `depositSignature`, not `sig`.
- No `any`. Evidence and journal records have explicit types.

## Commits and checks

- Keep one file per commit, introducing definitions before consumers so each
  intermediate commit remains valid.
- Each commit builds and passes `pnpm typecheck`, `pnpm test` and `pnpm lint` on its own.
- Behavior changes and refactors go in separate PRs.
- Never commit real private keys, measurement salts, or private prompts/responses; `.local/` stays ignored. Synthetic test inputs, ephemeral test material, public model-template fixtures and the curated historical on-chain metadata fixture are permitted.

The offline regression suites and their public fixtures are versioned and run
with `pnpm test`. The suite uses synthetic inputs, ephemeral unfunded signers,
mocked RPC/container process creation and temporary files; it requires no funded
wallet, Ollama, Docker, Python or devnet funds. `tooling/test-files.json` lists
every published test entrypoint; the runner rejects missing or unlisted suites.
Case modules in `tests/support/` are explicitly registered by those entrypoints.

Paid-call diagnostic cases spawn the real CLI entrypoint using the asynchronous
Node test-loader API. Stubs replace only its direct readiness/payment ports;
locks, temporary persistence, classification and evidence filtering remain real.
Each owned child has a 15-second deadline, forced cleanup and a 64 KiB output
limit per stream. Tests forbid RPC and assert one simulated invocation, without
loading funded keys or authorizing another payment. Receipt and deposit hints
remain unverified when the full proof fails.

Native transport cases require the pinned native Iroh binding and IPv6 loopback
`[::1]`. Before registering those cases, the test helpers probe SDK loading and
an IPv6 loopback socket. Missing bindings or known IPv6 capability errors produce
an explicit per-case skip reason; unexpected import/socket errors fail the suite.
Role setup and CLI recovery cases require the binding but do not require IPv6.
Other financial, lock, limiter and export cases keep running. Report passed,
failed, cancelled and skipped counts separately; skipped native cases establish
no transport result on that host.

Native fixtures use relay-disabled loopback endpoints and condition-based waits
for connection retirement and admission. The egress-expiry case retains unread
receive handles and stalls only its own loopback UDP return path to create real
native write backpressure. An owned buyer subprocess is paused with `SIGSTOP`
before it can recover via IPv6, then resumed and terminated during cleanup.
That single process-control case explicitly skips outside macOS/Linux. A passthrough observer forwards the original native
write and finish promises without replacing or delaying them. Warm-up waits
for native finish to settle and a subsequent event-loop turn before sending
the next request; write completion alone does not establish that the peer slot is free.
It advances JavaScript
`Date.now` across an admission window to fill the binding's send buffer within
two per-peer quotas; native clocks and ingress/egress timers remain real. Seven
other incomplete streams keep the remaining slots occupied while expiry closes
the stalled connection and a healthy peer uses its released slot. This is
simulated return-path loss with an unread receiver, not proof that non-reading
alone exhausts this SDK's buffers or a physical-network measurement.

`tests/fixtures/finalized-payment-pair.json` contains selected public metadata
and parsed financial instructions from a saved finalized deposit/claim pair.
Transaction signatures and the decoded public channel-creation nonce support
original identity/PDA checks; that nonce is not a private measurement salt.
Current-account responses and unsigned mutated transaction variants are labeled
synthetic. Do not add encoded payment/voucher payloads, raw logs, credentials or
private endpoint/content data to the fixture.

Raw evidence, measurements, agent files and internal documents remain outside
Git. The explicitly authorized, allowlisted redacted P2P reports
`lab/evidence/gate-0006.json` and `lab/evidence/gate-0007.json` are the evidence exceptions;
never publish raw role volumes, endpoint addresses, signed payment payloads or
private content. README, this guide, and the operational guides
`docs/inference.md` and `docs/limitations.md` are the public documentation
exceptions. Other private validation probes remain excluded; public case groups
run only through the entrypoints listed in `tooling/test-files.json`.
