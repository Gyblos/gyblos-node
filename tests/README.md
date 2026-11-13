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

Native admission tests hold the incomplete client stream until explicit cleanup
and wait for the server's real `acceptBi` result before opening the competing
connection. Client handshake/write completion alone does not prove server
admission. `control-admission-order.test.ts` controls native completion order to
verify this barrier for data and control ALPNs, and proves that inverted server
completion order can legitimately admit the second connection and refuse the
first. Injected connection and stream-open failures verify gate release and
fixture closure. The ordinary cap assertions and existing deadlines remain
unchanged. No product hook, fixed sleep, enlarged timeout or retry is used. The
original unforced timeout had no internal phase trace; controlled reproduction
establishes a test-ordering defect, not exclusive attribution of that historical
event.

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

The existing `acceptance:paid` startup harness also exercises `pnpm buyer`'s
automatic free-or-paid entry. A free listing is served with both zero and
positive buyer budgets over native Iroh: JSON, SSE and the actual terminal
workflow must complete without constructing the paid buyer runtime, loading its
tokenizer or making a payment authorization/deposit. The scripted terminal user
waits for receipt confirmation before exiting; a failed wait aborts its pending
terminal question and preserves the failure instead of hanging until the outer
watchdog. Snapshot observation waits for receipt work to become inactive with
one additional saved exchange before opening files: paired records on disk can
precede CONFIRM acknowledgment and connection settlement. The observer retains
the existing wait deadline, propagates failed/dropped work and storage errors,
and refuses snapshots after cancellation. `receipt-observation.test.ts` forces a
valid atomic replacement between open and inode validation; the private reader
continues to reject that race, while the observer waits for quiescence instead
of weakening the reader or retrying inference. Abrupt exit may cancel the
best-effort receipt exchange. It verifies signed receipt pairs on both roles and
after restart, private bounded metadata files and correlated completion events.
A later priced listing uses the existing simulated payment adapters; uncertain
paid state blocks a free listing across restart. Free and paid cancellation
retain one engine attempt and no prompt retry. Only the local synthetic identity
RPC is permitted; all other fetches outside the owned buyer and in-process index
fail the scenario, including calls during teardown. Report parsing requires
these phases, zero free payment-preparation counts and consistent separate
paid/free totals. No real payments, providers, Docker or production index are
used.

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

## Native payment-channel acceptance

`tests/lab/channel-crash-native.test.ts` and
`tests/lab/channel-crash-boundaries.test.ts` exercise actual payment modules and
journal recovery across real SIGKILL/restart. The authoritative LiteSVM and
synthetic keys stay in the parent; a killed buyer cannot roll back the chain. An
owned private IPC bridge supplies all signer/RPC ports, including decoded native
pre/post SPL observations for financial reconciliation. No public RPC or
pre-existing keys are used. The synthetic SDK testnet label matches the pinned
SBF treasury; it does not enable product mainnet or prove deployed devnet
compatibility. Same-host dead-owner locks recover normally; ambiguous locks stay
blocked. See [recovery.md](../docs/recovery.md#offline-abrupt-exit-acceptance)
for limits.

`tests/lab/paid-native.test.ts` executes the installed metered SDK's signed open
and claim transactions in LiteSVM, using the bundled, hash-checked official
program fixture and a synthetic mint. Payer closure, voucher/grace boundaries,
actual token movement, fresh-blockhash replay and confirmation-loss recovery are
covered without RPC, files holding keys, devnet or real funds.

The feature/network label selects compatible treasury constants inside the VM;
product mainnet remains disabled. These are SDK/native-program semantic tests,
not current-devnet product startup, Iroh, an engine or deployed-binary
acceptance. See
[scope, prerequisites and rebuild instructions](../docs/paid-native-acceptance.md).

## Concurrent seller product acceptance

`node --import tsx --test tests/lab/http-multiseller-acceptance.test.ts` runs
the real buyer HTTP entry and two product seller processes with separate
temporary homes. The actual discovery index uses memory storage over loopback;
8004 account reads, engines and financial confirmations are synthetic. Native
Iroh is required, with the ordinary explicit capability skips. No real RPC,
relay, index, payment, engine, deployment or operational home is used.
Successful queue renewal uses the existing configured default; a separate
short-deadline phase proves expiry. Native signing and private writes are not
required to fit the intentionally shortened expiry test deadline. Product
capacity and deadlines are unchanged.

The parallel case observes actual busy withdrawal and republication before
starting another prompt; it never assumes a fixed sleep restored availability.
The cases cover concurrent A/B execution and A reuse after buyer restart,
independently verified final charge/refund, same-seller queue expiry and HTTP
disconnect, fresh quote correlation, a shared-budget race, and A uncertainty
while B is already sent or still before its first prompt write. The latter
blocks new requests and survives buyer restart without replaying either prompt.
The buyer must read discovery after startup, and an unavailable index prevents
the first prompt. Cancellation waits for the actual server-side HTTP close and
releases the engine before queue expiry; a request cannot pass by merely timing
out. Phase watchdog regressions bound missing barriers and early HTTP failure.
Only numeric/status evidence leaves the scenarios; synthetic request/response
content, keys and financial payloads stay out of output. Existing limits and fee
arithmetic remain unchanged. This is local composition evidence, not a
live-chain, deployed-program, real-engine or power-loss acceptance claim.

## Paid session conversations

`tests/batch-conversation*.test.ts` exercises complete-history recounting,
quote/context/budget bounds, cumulative approvals, cancellation and lost-ACK
restart. `batch-legacy-vectors.test.ts` independently freezes v1 bytes while
current vector tests use new v2 fixtures. SDK journal/voucher formats stay
unchanged, including recovery of an original v1 bill over the v2 RPC.

`tests/lab/paid-conversation-startup.test.ts` runs product buyer HTTP and native
Iroh seller startup in single-session and pooled modes, with fake engines and
financial observations. It reuses a deposit across conversational requests and
peer restart, then checks the synthetic final charge/refund. Native absence is
explicitly skipped and does not prove acceptance. The delayed-tokenizer case in
`paid-conversation-loader.test.ts` proves HTTP cancellation frees router
admission before initialization completes and a late completion starts no
financial work.

The opt-in `paid-conversation-tokenizer.test.ts` uses the real pinned public BPE
artifacts without a real engine. Set `GYBLOS_TEST_TOKENIZER_HOME` to an owned
`/tmp/gyb-paid-chat-tokenizer-*` (or `/private/tmp/...`) artifact home prepared
with `prepareModelTokenizer`; both artifacts are hash-checked again. The test
rejects other locations before reading files. With no explicit artifact home it
is reported as skipped. Synthetic count tests always run; no artifacts are
committed and no existing operational home is read.

### Reusable paid session streaming

`batch-streaming.test.ts` checks visible text before engine completion, one
reused deposit, cancellation, conflicting output and financial-only ACK
recovery. `batch-stream-protocol.test.ts` checks sequence/correlation, EOF,
backpressure, encoded bounds, uncertain first writes and static LIMIT fallback.
New v3 vectors are checked independently; all v1/v2 fixture bytes stay frozen.
`lab/paid-session-streaming.test.ts` exercises actual buyer HTTP and native Iroh
seller startup with synthetic engines and financial services, in single and pool
modes, including disconnect before another fragment. No native support means not
executed, not successful acceptance. Cancellation before a verified terminal
must not create an approval or retry a prompt; an already-started financial
approval remains recoverable using its original bytes.

## Free agent tool-loop acceptance

`node --import tsx --test tests/lab/tools-acceptance.test.ts` calls the lab-only
`runToolAcceptance({ signal? })`. Each scenario starts an isolated child with
fresh private homes and an allowlisted environment. The actual memory discovery
index, synthetic read-only 8004 registry, product seller and `buyer:free`,
native loopback Iroh, and product OpenAI adapter participate. A scripted
in-memory provider supplies tool calls and usage; no model, external tool or
public service is contacted.

OpenAI and Anthropic client formats each complete JSON and streaming loops:
system/history and `get_time` reach the provider unchanged, a validated call is
returned, the client supplies the fixed synthetic result, and a second request
returns the final answer. Each loop has exactly two generations and two
execution dials. Streaming tests the existing complete terminal tool-call
format; it does not promise incremental argument delivery. The provider adapter
remains OpenAI in all four cases: Anthropic here names the buyer's HTTP format.

Negative cases cover invalid schema/choice/result sequences before generation,
unsupported seller capability before an execution dial, malformed provider
output, interrupted terminals and disconnect cancellation without retry. For the
unsupported-capability case only, the existing engine composition port overrides
`supportsTools` to false while preserving the real adapter and executor. The
automatic `buyer` entry still refuses tools before selection or financial
preparation. Existing pending-receipt concurrency coverage remains independent;
there is no global receipt wait.

Only fixed case names and counters leave the children. Financial factories fail
if called, and the fetch allowlist rejects foreign I/O. Native unavailability is
reported as not executed and cannot establish acceptance. These are local
composition tests with declared synthetic usage, not evidence for live agents,
provider behavior, independent tokenizer billing or deployed-network
reliability.
