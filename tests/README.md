# Offline regression tests

| Command             | Runs                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm check`        | Typecheck, lint (including tooling), product and lab tests.                                                 |
| `pnpm test`         | Product suites `tests/*.test.ts` and standalone package tests `packages/*/test/**/*.test.ts` (the PR gate). |
| `pnpm test:lab`     | Lab-only regressions `tests/lab/**/*.test.ts`.                                                              |
| `pnpm test:all`     | Product, standalone package and lab tests.                                                                  |
| `pnpm tooling:test` | Tests of the boundary checker and lint rules, `tooling/**/*.test.ts`.                                       |

Node discovers test files by glob; there is no allowlist, and every case is a
top-level `test()` in a `*.test.ts` file.

- `tests/*.test.ts` exercise product packages and apps through their public
  entries. They never import `@gyblos/lab-harness` or `lab/`.
- `tests/lab/` covers lab code (gate harness, standalone lab facilitator, exact
  scheme, journals, lab tools and entrypoints) and the opt-in identity
  integration with its validator helper.
- `tests/support/` holds fixtures, fakes, fault catalogs and helpers only, no
  test cases. Both suites may import it. Contract suites that every plugin of a
  port must pass live there as `*-contract.ts` and are run by one
  `tests/*.test.ts` per plugin.
- A standalone package (see AGENTS.md) keeps its own tests in
  `packages/<name>/test/` so they leave the monorepo with it; they import only
  that package.
- `tooling/**/*.test.ts` test the repository tooling, not the product, and are
  counted separately.

## What the suite needs

No funded wallet, Ollama, Docker, Python, devnet funds or network. It uses
synthetic inputs, ephemeral unfunded signers, mocked RPC and temporary files.
Paid-call cases spawn the real CLI with stubbed payment ports and assert that no
RPC is made. Cases that touch local data run in a temporary working directory
(and set `GYBLOS_HOME` or `GYBLOS_LAB_HOME` inside it when needed);
legacy-layout cases create synthetic paths there and never read a real
`.local/`.

## Native skips

Iroh transport cases need the pinned native binding and IPv6 loopback `[::1]`.
The helpers probe both first; a missing binding or a known IPv6 error gives an
explicit per-case skip, while unexpected errors fail the suite. The egress case
that pauses a child with `SIGSTOP` and the lock ownership/FIFO cases skip
outside macOS/Linux. The discovery index `sqlite-d1` cases use `node:sqlite`
(unflagged since Node 22.13) and skip where it is missing. Report passed,
failed, cancelled and skipped counts separately; a skipped case proves nothing
on that host.

## Opt-in identity integration

`GYBLOS_IDENTITY_INTEGRATION=1 pnpm test:lab` starts a throwaway
`solana-test-validator` on loopback ports 18000-19999, cloning the 8004 program
and registry accounts read-only from public devnet. Its ledger stays in the
ignored lab home (`.local/lab/identity-validator/` by default). Without the
binary, or if devnet is unreachable, the four cases skip with a reason.

## Fixtures policy

- `fixtures/finalized-payment-pair.json`: selected public metadata of one real
  finalized deposit/claim pair. Current-account responses and mutated variants
  are labelled synthetic. Never add payment payloads, logs or credentials.
- `fixtures/identity-devnet-accounts.json`: two public registry accounts,
  captured by `lab/tools/identity-fixtures.ts`. `pnpm identity:fixtures`
  recaptures it from devnet with read-only RPC calls and overwrites the file.
- `packages/protocol/vectors/public-discovery-v1.json`: synthetic keys and
  signatures only.
- Raw evidence, measurements and private notes stay out of Git. Keep manual or
  private probes outside the discovered test tree.

## Node and discovery acceptance

`tests/lab/node-discovery-acceptance.test.ts` covers the reusable local lab
command, its default synthetic engine, native Iroh capability boundary, private
temporary homes, in-process index, cancellation and static output. It exercises
renewal, failure/expiry/busy recovery, durable restart and replay refusal
without payments or RPC. Native cases use the same explicit capability gating as
other Iroh tests. The command has a separate real-Ollama opt-in that CI never
runs; see [the acceptance procedure](../docs/node-discovery-acceptance.md).

`tests/lab/free-acceptance.test.ts` adds the synthetic-only complete free
journey through the actual local index, native Iroh and product buyer HTTP
endpoint. It checks renewal answers, typed execution refusals, persistent public
replay state, caps and pre-/post-send failures. It also checks early
cancellation, CLI privacy and native-unavailable behavior; no TCP/mock fallback
or real-engine option is supplied by the free command.

`tests/lab/free-acceptance-review.test.ts` pins the synthetic HTTP finish reason
and choice index, plus cleanup on control-client initialization failure. An
owned endpoint closes on failure; a borrowed endpoint stays caller-owned. The
initialization probes use in-memory doubles and never bind native sockets.

Free streaming cases cover the ordered/correlated wire frames and new golden
vectors, bounded engine callbacks and cancellation, shared seller replay/caps,
possible-send tracking, OpenAI-compatible SSE and no post-send failover.
`tests/lab/free-stream-acceptance.test.ts` exercises the real local index,
native Iroh, synthetic engine and product HTTP endpoint, including early
fragment delivery and cancellation that reaches the seller engine.

Identity resolution and policy tests use signed synthetic account fixtures and a
loopback/in-memory RPC double only. They cover finalized/genesis-pinned
read-only methods, owner transfer, metadata removal/burn, ambiguous assets,
claimant limits, cancellation/late results, high-water rollback refusal and
manual override/tombstone retention. No opt-in identity integration is enabled
for these tests. Legacy resolver tests remain separate compatibility coverage.

Identity persistence and buyer admission suites use canonical temporary homes,
synthetic signed registry accounts and loopback RPC/control doubles. They cover
manual provenance, owner rotation, tombstones, exact u64 floors, unsafe storage
and refusal before prompt/authorization forwarding, without live-registry or
mainnet acceptance. No opt-in identity integration is needed for these suites.

Bounded identity RPC suites use injected decoded streams and actual gzip over
loopback HTTP. They cover exact limits, absent/incorrect length headers, UTF-8,
fragmentation, cancellation, monotonic deadlines, late-body disposal and exact
SDK BigInts. A buyer regression compares valid padded JSON on the old transport
with the bounded default and proves overflow cannot revoke persisted identity.

`tests/lab/identity-acceptance.test.ts` composes the real buyer identity
startup, bounded HTTP RPC reader and durable registry policy with native
free/streaming inference, a local in-process index and a fake engine. Signed
synthetic 8004 accounts are served on allocated loopback HTTP only. It covers
renewal, outage, response limits, revocation before send, explicit manual
override/removal, durable owner/sequence barriers, seller restart, cancellation
and no post-send retry. Native unavailability is explicitly skipped in tests and
fails the standalone `acceptance:identity` command; it never counts as
successful acceptance. No live RPC, chain registration, real engine, payments or
desktop is exercised.

Free receipt integration is covered by `receipt-store.test.ts` (private files,
strict snapshots, retention and compare-and-set), `free-receipt-seller.test.ts`
(actual usage and failure isolation), `free-receipt-policy.test.ts` (buyer
observations and no inference retry), `receipt-family.test.ts` (connection
isolation) and `free-receipt-iroh.test.ts` (native complete/streaming exchange
with temporary homes and a synthetic engine), `free-receipt-deadline.test.ts`
(slow storage outside inference deadlines) and `receipt-composition.test.ts`
(per-offer production forwarding). Native skips are not acceptance.

`tests/lab/receipt-acceptance.test.ts` exercises product startup to confirmed
private receipts through an isolated child, local memory index, native Iroh and
in-memory provider. It covers both HTTP modes, restarts, old catalog rejection,
receipt/engine failures, cancellation, configured free caps and retention
checks. It now also hands the actual confirmed pairs to the private collector,
persists them, reopens in a separate process, verifies exact duplicates and
checks bounded refusal without inference retry. Focused synthetic coverage is in
`tests/lab/collector-acceptance.test.ts`. No uploader is enabled. The child
inherits no credentials or role settings; parent globals stay separate. The
standalone command is `pnpm acceptance:receipts`; native skips prove nothing.

The local collector is covered by `local-collector*.test.ts` and
`retained-receipts.test.ts`: synthetic buyer-scoped capabilities, Host/browser
refusal, deadlines/quotas, exact duplicate and conflict handling, retention
tombstones and clean reopen. Existing receipt-file suites protect compatibility
of the version-1 store. All storage belongs to disposable directories; HTTP uses
loopback only and no uploader or real credentials are activated.

`tests/lab/paid-startup-acceptance.test.ts` runs actual paid seller/buyer
startup over native loopback, synthetic chain services and private temporary
journals. It also drives the product terminal loop with synthetic streams,
checks a mid-answer engine interruption and reconciles a simulated settlement.
See [the acceptance boundary](../docs/paid-acceptance.md).

## Timing-sensitive fixtures

Capacity assertions do not measure disk speed: the telemetry pending-buffer test
controls only its drain timer while exercising real private writes. Separate
cases advance that timer to verify timeout health; real private-log timeout
coverage remains enabled.

Synthetic watchdog and reader-controller imports do not load Iroh or probe
sockets. The owned unread Iroh child loads native setup only in its entry
function and announces READY after installing IPC. Its startup has a separate
bounded wait; CONNECT keeps its original budget, and native egress timing begins
only after preparation. Missing readiness, early exit and late messages are
covered without sockets; the native egress test still checks the product
deadline, connection closure and admission-slot release.

Synthetic paid-service deadline tests coordinate entry and digest completion
before advancing their clock. Their abort wait accepts cancellation that already
happened. Test watchdogs use a pure, mockable timer; boundary cases assert
before and at the original deadline. Cleanup releases a stable blocked-write
promise even if preparation has not reached the writer yet, so a failed
assertion cannot strand the test worker or erase the lease-retention assertion.
These fixtures do not change product transport, payment or logging limits.
