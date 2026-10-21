# Limitations and recovery

This repository is an experimental TypeScript x402 payment foundation for
Gyblos. It exercises Solana devnet fixed resources and a local Ollama inference
gate, plus an experimental native Iroh PoC. One earlier Wi-Fi Mac–VPS direct
trial completed three paid devnet requests using a test SPL mint, not USDC. That
report is historical; it does not validate the current source. The exact
candidate hash and final-head paid-smoke status belong to
[PR #10's validation record](https://github.com/Gyblos/gyblos-payments/pull/10).
The additional `24af211` attempt is partial: the first request completed, the
second settled on-chain but left an uncertain buyer journal, and the third never
started. Later fixes have offline validation only; the precise historical error
was discarded and remains unknown. A new paid smoke needs explicit VPS/funds
approval and must use its unchanged final commit. Docker NAT-direct did not
pass; hotspot/CGNAT and broader NAT coverage remain untested. Use isolated
generated devnet wallets only. Never import mainnet keys.

## Payment scope

The fixed `upto` gate demonstrates a signed spending ceiling, a smaller charge
and unused-deposit return through a payment channel. It checks distinct
confirmed open/claim transactions, buyer/seller balance changes, unchanged buyer
SOL, channel distribution and fixed-resource delivery. An unpaid HTTP 402
challenge alone establishes none of the paid settlement/refund behavior.

The six-decimal fallback SPL mint is labeled `devnet-test-token`, not USDC.
Provisioning preserves existing keys and does not mint additional tokens if that
mint already exists. Inference accepts the explicitly configured test token or
Circle devnet USDC; the public fixed-price gate requires Circle devnet USDC.

The fixed failure gate covers an empty buyer and an expired authorization, each
without resource execution or charge. Expiry has a roughly 60-second validity
window plus a two-second grace wait; setup and RPC work add to total runtime. It
is not a replay or seller-crash recovery test.

## Public fixed-price facilitator

The public `exact` route charges 10,000 atomic units (0.01 Circle devnet USDC)
for a fixed resource. It provides neither usage metering nor an unused-ceiling
refund. It runs alongside the local `upto` route and does not replace it. Its
seller uses an ephemeral loopback port and settles before resource execution.

The primary provider is `https://x402.org/facilitator`; the configured backup is
`https://facilitator.payai.network`. Capabilities are queried and recorded from
`/supported` before paying. A changed capability or fee payer stops the gate.
Paid interoperability has been verified with x402.org; the PayAI backup has not
been tested with a payment. Availability depends on these third parties.

Before signing, the buyer validates network, Circle mint, price, recipient and
fee payer. Negative cases reject an unexpected mint, recipient or fee payer. A
buyer without USDC is rejected locally before signing, without submitting its
payment to the public provider. Replay is rejected without another resource
execution, but the guard is limited to the same seller process; protection
across restarts or distributed sellers has not been validated.

The isolated local facilitator wallet sponsors token-account provisioning. The
public facilitator sponsors the payment transaction; the buyer's SOL should not
change. This does not remove the need for devnet SOL for provisioning.

## Uncertain outcomes and manual reconciliation

- A timeout does not establish absence of payment, failure or refund. A
  potentially uncertain settlement is recorded and blocks new payments until
  reconciled on-chain.
- A buyer disconnect after generation can leave a confirmed charge without a
  delivered answer or payment-response header. Reconcile that outcome as charged
  but undelivered; do not assume a refund or repeat the payment.
- An absent transaction in a history query does not prove payment failure. The
  gate does not automatically switch providers after attempting settlement.
- A crash may leave `.local/devnet/buyer.lock` or an unresolved journal. Do not
  delete these to retry without first inspecting the authorization and its
  transactions.
- The local facilitator uses in-memory storage. Durable recovery, unilateral
  channel closure and subsequent recovery of all channel PDA rent have not been
  validated.

Use the recorded public transaction signatures, authorization metadata and
on-chain balances to establish the outcome before another authorization. There
is no general automatic recovery or guarantee that an interrupted run has
returned funds. The P2P zero-charge recovery command below covers one explicitly
verified case; charged-but-undelivered outcomes still require separate recovery.

P2P paid calls now retain a canonical failure phase and allowlisted diagnostic
code, filtered per-request route metrics, and available HTTP status/signature
hints. `observedPayment` contains only bounded syntactically valid claim/deposit
signatures; it is not verified settlement or evidence of delivery. The shared
buyer preserves receipt-header hints even when body parsing fails. Arbitrary
error messages, stacks, causes, response bodies and credential URLs are not
copied into these diagnostics.

After a confirmed claim, deposit discovery rereads a temporarily missing index
within the existing configured transaction-read budget. History queries and the
post-claim snapshot use the known claim slot as `minContextSlot`; an account
response reporting an older slot is rejected even if its amounts happen to
match. The claim slot must first be a nonnegative safe integer; missing or
malformed slots stop before history/snapshot reads. Only reads are repeated.
Ambiguous deposits and accounting mismatches fail immediately. An exhausted read
budget still leaves uncertainty and blocks new authorization. The
[account RPC context minimum](https://solana.com/docs/rpc/http/getmultipleaccounts)
is distinct from finalized proof. These reads use the existing confirmed
commitment, do not replace the finalized recovery verifier and do not guarantee
timely RPC indexing.

A discovered deposit is persisted as an unverified hint before subsequent
snapshot/delta checks. Only a completed proof establishes the confirmed
financial classification; a later receipt/observation failure keeps the existing
`confirmed-payment-error` distinction. A nonmissing unreadable/malformed metrics
file after proof is now reported as `confirmed-payment-error` at the metrics
phase; a missing file still yields empty samples and a route discrepancy. This
refines the old empty-route classification without losing confirmed financial
state. These reproducible fixes cannot recover the lost original error,
establish the second request's delivery/paid route, clear its charged journal or
restore a current-account audit after canonical reclaim. Do not use the
zero-charge recovery path for that charged outcome.

## Private facilitator diagnostics

The standalone facilitator and P2P seller persist only the new allowlisted
attempt stream. Each record has an independently generated instance/attempt ID,
a sequence number, timestamp, elapsed time, SDK version, operation, normalized
deposit/claim phase and stage. Optional channel IDs, atomic amounts and
transaction signatures pass bounded syntax checks. Errors map to canonical
categories; their messages, stacks, causes, arbitrary SDK reasons, request/body
objects, signed payloads, environment values and URLs are not serialized. A
signature is an observation hint, not a confirmed payment.

The stages distinguish policy rejection, an SDK return or exception and local
HTTP finish, early close or error. SDK `success: false` can be returned with
HTTP 200, leading the seller middleware to answer 402. An early close before
headers omits the unobserved default status. HTTP finish proves neither remote
receipt nor delivery. A missing record can mean diagnostic loss; it is not proof
that an SDK operation never ran. These new records cannot reconstruct the lost
historical exception or identify the precise cause of the `24af211` second
request. That authorization remains uncertain and charged historically; do not
retry it, clear its journal or invoke zero-charge recovery.

The queue is nonblocking and bounded to 128 pending records, each at most 4 KiB,
with a 4 MiB file budget. New instances exclusively reserve one of 16 file
slots. Preserved legacy files consume this budget; incompatible mixed slot
layouts fail closed for logging. There is no automatic truncation, repair,
rotation or deletion. Archive only closed diagnostic files to private storage as
operator maintenance, separately from payment journals and locks.

`GET /gate/diagnostics` is exposed by the loopback actors and returns only
canonical health and counters. `synced` means append, file sync and identity
checks completed; enqueue is not durable retention. Initialization or append
failure, exhausted limits and drain timeout produce degraded health and a fixed
warning without printing paths or raw errors. These failures do not replace SDK
responses, authorize payment or cause payment retries. A damaged append poisons
that writer; a restart reserves a separate file, preserving the old tail for
private investigation.

Flush and full descriptor close have a two-second bound. A timed-out close
reports `closed: false` while cleanup remains pending; initial directory/file
opening is not deadline-bounded. Normal actor shutdown drains queued records,
not disconnected in-flight SDK operations. A crash, forced exit, failed cleanup
or late SDK return can lose pending events. Diagnostic persistence does not make
the SDK's channel storage durable and does not implement reconciliation.

Owner/mode, link and inode checks plus `O_NOFOLLOW` protect cooperative local
POSIX storage on macOS/Linux. They are not a defense against an adversary
controlling the same OS user. Windows ACL guarantees are unvalidated; POSIX file
tests explicitly skip there, while pure projection/observer tests run. The older
in-memory `/gate/events` and `/gate/verifications` retain their existing
behavior and arbitrary legacy fields; they are not persisted by this writer and
are outside its safe-projection guarantee. Do not publish them as sanitized
evidence.

Loopback binding alone does not stop DNS rebinding: a web page can resolve its
own name to `127.0.0.1` and make the browser read local responses. The
facilitator, gate/inference/exact sellers and the P2P buyer proxy therefore
reject any `Host` other than `127.0.0.1`, `localhost` or `[::1]` with the exact
local port (empty 421, before routes and body parsers; Node rejects HTTP/1.1
without `Host` with 400 first). This is not authentication: any local process,
or a browser page served from a loopback origin on that port, can still call
these routes. Ollama is a separate process and is not covered by this check.

## Inference and verification limits

Buyer measurements have no signed seller receipt. Token recounts detect
within-ceiling overcharge after settlement; they do not prevent, automatically
refund or penalize it. The visible-output/EOS convention and declared tolerance
remain explicit. See [inference details](inference.md).

Model manifest and tokenizer pins check the gate's local artifacts. They do not
authenticate a remote seller's model with LOGIC or establish answer correctness.
The local gate does not validate P2P transport. The separate Iroh PoC does not
implement reputation scoring, penalties, MPP, mobile apps or mainnet. Responses
are buffered; buyer-facing streaming and first-word latency are not implemented.
Killing the gate-owned engine is not durable recovery of a crashed seller or
facilitator.

The fixed-resource gates retain their own scope. A successful fixed-resource or
public `exact` result does not validate metered inference, P2P transport or the
correctness of delivered content.

## Local files and configuration

Keys, journals and diagnostics normally live under `.local/devnet/`. Key files
must never enter logs or shared results. Measurements and the private salt use
fixed paths in that directory; model artifacts live in `.local/ollama/models/`.
Changing `GYBLOS_GATE_CONFIG` selects a config file without relocating these
other paths. Inference requires the default isolated key paths.

The public-facilitator report is saved locally to `evidence/gate-0004.json`,
with advertised capabilities, signatures and public metadata. The inference
report is at `evidence/gate-0005.json`; fixed-resource results and
failure/challenge reports stay under `.local/devnet/`. These reports are not
signed seller receipts. Keep private files local and review output before
sharing it.

Configuration is read from the process environment and config file; `.env` is
not loaded automatically. RPC identity is checked using the devnet genesis hash.
Operational paths and ports are defined in `@gyblos/config`, with the public
commands and defaults in the [README](../README.md#configuration).

## Experimental native transport

The flat Docker trial uses a separately pinned owner-signed offer, actual remote
NodeId verification and bounded HTTP framing over Iroh. The exact per-request
ceiling is independently calculated before signing. The seller exposes only the
paid inference route; Ollama and the facilitator remain loopback-only. Role keys
and journals stay in distinct container volumes under `.local/p2p/`.

An initially uncertain engine error was reconciled through finalized chain
transactions as zero charged and a complete unused-deposit return. An HTTP error
alone never establishes that result. Preserve failed attempts and their original
image/source identity when rebuilding; do not delete journals to rerun a case.

Native routes are sampled observations. Direct connections reveal peer IPs.
`GYBLOS_RELAY_ONLY` configures the seller only. The buyer still uses a default
endpoint and has no enforced relay-only privacy mode: asking for a relay route
or omitting seller direct candidates does not prevent buyer IP disclosure.
Off-host relay-only privacy remains untested. Docker NAT-direct readiness did
not pass; a separate inbound-UDP-blocked relay session did complete paid calls.
An in-session direct-to-relay transition and broader success rates are unproven.
The later native Mac–VPS result does not explain the original Docker return
path.

Request ingress has a separate five-second deadline. Execution allows one active
request per NodeId and two globally. Its permits are released when the origin
finishes, before response delivery. Egress has its own five-second deadline; at
most eight streams retain native ownership until their operations finish,
including late writes after the connection closes.

Pending native handshakes and established connections have separate limits of
eight. Validated source addresses admit at most two pending handshakes per IP
without counting source ports as new identities; established connections are
limited to one per NodeId. Connected or active peers reserve their available
per-minute allowance within the shared budget of 256 requests. Other peers
cannot reclaim that protected reservation. Disconnected, inactive grace is
best-effort: registration or quota refill may reclaim unused quota, and LRU
pressure may evict inactive reservations. Reclamation changes no consumed debt
or active/lease ownership. Each NodeId's consumed allowance is stored separately
until rollover, including after eviction. Its map is bounded by the 256 actual
admissions per window; the peer-window table retains its separate 128-entry
bound. At lease release, unused quota is returned when the identity has no
current-window admitted work and no active operation. Otherwise, inactive quota
remains reclaimable. Rollover resets window debt and refreshes connected
reservations while retaining in-flight ownership, including requests started in
the previous window.

Reconnection can reuse or refill an allowance only while shared capacity
remains. It does not guarantee a disconnected identity capacity against
competing work. A connected peer with an exhausted partial reservation may need
to reconnect before obtaining newly freed allowance. Free challenges and failed
origin work still consume the same admission budget. About nine identities
attempting 30 free requests each per minute can deny new peers for the window:
eight consume 240 admissions and the ninth consumes the remaining 16 of 256. No
payment is required; this is not Sybil resistance. A payment header, prior free
request or HTTP status grants no special entitlement. The earlier
nine-single-request/disconnect regression now passes with real direct-loopback
Iroh: unused inactive grace is reclaimable, while actually consuming all 256
admissions denies additional new and disconnected known peers until rollover.
The former test expecting a dormant free identity's untouchable quota under
exhaustive churn is superseded; its historical results do not establish the
current best-effort contract. Connected/active reservations remain protected.
This does not prevent cheap identities from exhausting actual work budgets or
holding bounded connection/native pools, and it is not production fairness.

IP source budgets use full addresses rather than IPv6 prefixes; IPv4-mapped
aliases are separate keys. Relay source keys use the remote endpoint identity,
which is inexpensive to replace. Those keys do not bound an actor controlling
multiple addresses or identities.

Application-idle connections expire after 30 seconds. A 15-minute lifetime
retires a connection after active work drains. Expired handshakes preserve the
seller endpoint and close late results, but the binding cannot cancel an
individual native handshake. Its pending reservation stays occupied until native
completion. Permanently stuck native handshakes or writes can exhaust their
bounded pools. Multiple independent sources can exhaust pending capacity, and
peers behind a shared NAT can encounter the source limit. These controls are not
Sybil resistance or a production DoS guarantee. The revised admission policy has
been tested with direct loopback Iroh; its relay and physical-network
compatibility has not been newly validated.

Required-route mismatches are blocked before opening/writing a request when
observed. Later sampled wrong/mixed routes, or unavailable telemetry, produce a
`route-discrepancy` result while retaining independently confirmed financial
state. Route checks cannot prove every packet used the requested path. A proved
charge with an invalid receipt or later processing failure remains a
`confirmed-payment-error`, not an inferred refund or an automatic retry.
Post-exchange metrics are best effort and cannot replace a delivered
`200`/receipt.

The trace's pre-inference timestamp labels a local hook after deposit admission;
it is not independent engine-start timing. Generation-order evidence combines
canonical deposit validation, full-escrow observation and the awaited code path.
It does not authenticate remote model/content correctness.

The explicitly authorized redacted reports are `evidence/gate-0006.json` for
Docker/diagnostics and `evidence/gate-0007.json` for physical-network attempts.
They contain public settlement metadata and synthetic-case measurements, not
keys, salts, content, signed payment payloads, RPC URLs or endpoint addresses.
Raw measurements and reconciliation records remain private. See the
[Docker command](../README.md#experimental-iroh-docker-trial) for prerequisites.

## Verified P2P reconciliation and reproducible audits

`pnpm p2p:reconcile --deposit DEPOSIT_SIGNATURE --claim CLAIM_SIGNATURE`
verifies finalized transactions and the canonical distributed channel before
saving a zero-charge/full-return record and then confirming the matching local
buyer journal. Preserve the original authorization journal, role/trust metadata
and owner-signed offer. If interruption prevented the call row from being
written, a complete durable authorization journal can supply the original
request, channel, ceiling and payment identities. Incomplete metadata or
conflicting call rows stop recovery; missing call history is never fabricated.
An expired signed offer can supply historical identities for this read-only
chain workflow; it never authorizes a new payment. Existing failed calls remain
in history. Proof/record failures leave the journal unresolved; record
persistence precedes the journal transition. Charged outcomes are rejected by
this zero-charge command.

Default recovery serializes through a separate recovery lock. It can retire a
buyer lock only after validating its private regular-file metadata, matching its
versioned ownership domain and proving its recorded local PID is absent. Linux
binds the host, boot ID and PID namespace; macOS binds the host and a bounded
boot-session query. Legacy, missing, mismatched or unavailable identity stops
automatic retirement before any PID probe. `startedAt` records lock acquisition,
not OS process start; live/reused PIDs remain busy regardless of age.

Buyer/audit opens are nonblocking and no-follow; FIFOs, symlinks, hardlinks,
unsafe filesystem identities and ambiguous metadata stop recovery. A stale-lock
audit is synchronized before removal and file identity is rechecked. Normal
exclusive locking remains usable with unverifiable owner metadata, and cleanup
only removes the acquired inode, preserving replacements and original operation
errors. An interrupted recovery lock requires manual investigation. These are
cooperative local-process checks: comparison and unlink are separate operations,
not protection against hostile same-privilege replacement or a multi-host lock
protocol. No cross-container shared-volume experiment has been run.

Add `--audit-only` to verify either a charged or zero-charge payment without
changing journal/reconciliation files or retiring stale locks. This mode only
acquires the normal buyer lock. Both modes use RPC reads, with no signer,
funding, submission or payment retry. Keep output private. The verifier checks
finalized statuses, transaction errors, transfer identities, exact token/SOL
deltas and canonical channel ownership, layout, PDA and settlement. Sponsor fee
and rent conservation is checked independently inside each transaction,
including the canonical escrow ATA's temporary rent advance and return. Its
creation must be sponsor funded with the token program's account owner/size;
closure must be authorized by the channel and return rent to that sponsor. Fresh
creation, safe balances and complete closure are required. Escrow/channel
lamport credits between the selected transactions and later channel credits do
not invalidate an otherwise consistent proof. Every selected transaction must
still conserve its exact sponsor/channel/escrow deltas against its fee. Negative
interval changes, a claim-time channel withdrawal, later channel depletion or an
initial channel allocation below the checked minimum fail closed; positive
credits cannot compensate for these failures or changed token settlement.

`retainedChannelRentLamports` records the initial sponsored channel allocation;
actual channel deposit/claim/current snapshots and nonnegative observed changes
are separate fields. `escrowAccountRentLamports` remains the initial sponsored
ATA allocation, with its interval credit reported separately. Credits are net
observations, not proof of donor identity or of every intervening operation;
they are neither network fees nor unused-token refunds. Explicit sponsor
snapshots likewise separate transaction deltas from unrelated interval activity.
Current wallets never supply historical token balances.

Positive net same-mint token credits between the selected deposit and claim are
accepted only when the full surplus goes to the canonical devnet treasury ATA,
derived from the configured treasury owner and expected mint. The principal
charge plus buyer refund must still equal the original ceiling; the measured
charge must still match the canonical channel settlement. The treasury token
delta must equal the gross sweep, which must equal the escrow's observed token
surplus. Buyer/seller token deltas, empty escrow closure, SOL fees and rent
remain independently checked. Surplus cannot compensate for principal loss or be
classified as a buyer refund or fee.

The new `escrowInterveningTokenCreditAtomic` and `treasurySweepAtomic` fields
separate that observed surplus from principal. Escrow token balances before and
after each transaction are reported in `escrowDepositBeforeAtomic`,
`escrowDepositAfterAtomic`, `escrowClaimBeforeAtomic` and
`escrowClaimAfterAtomic`. These are net observations without donor attribution
or a complete interval history. `balanceDeltas.escrow` keeps the
initial-empty/final-empty endpoint value; the historical snapshots disclose the
intervening increase. Missing fields in older records mean not recorded, not
verified zero. Zero-charge recovery still requires the full principal returned
and no charge; its persistence and export retain the separate surplus fields.

Buyer, seller, escrow and treasury ATAs must be distinct. The selected deposit
allows only buyer-to-escrow token transfers, and the claim only escrow-to-buyer,
escrow-to-seller and escrow-to-canonical-treasury transfers, all in the expected
mint. Prefunded escrow accounts, claim-time incoming transfers, unrelated or
compensating token transfers and arbitrary additional transaction shapes remain
unsupported. This is deliberate fail-closed compatibility scope.

This verifier is deliberately limited to fresh, individually settled channels
with retained canonical accounts. Closed/missing channels, nonfinalized data,
deltas violating the checked sponsor/channel/escrow equations or unsupported
shapes stop verification. It does not recover rent or guarantee recovery from
every crash. Evidence export re-fetches proof for zero-charge reconciliations
and binds their ceiling to the original attempt. Confirmed paid rows still come
from the call journal. Source/image provenance is separate from chain truth and
remains explicitly unverified when supplied by an operator.

Paid Docker/NAT export reports `preInferenceEscrowExcessAtomic` separately from
the original ceiling and raw balance snapshot. It accepts a pre-inference escrow
observation covering that ceiling, validates canonical nonnegative integer
strings and a positive ceiling, and retains exact principal charge/refund,
unchanged seller balance, unique request/channel trace and required-route
checks. This is local evidence consistency, without an independent finalized
proof of the paid journal rows. Observed pre-inference excess can differ from
the later finalized interval credit or treasury sweep; its donor and eventual
disposition are not established by the trace. Missing fields in older reports
mean unrecorded. Public offline collector tests use synthetic paid rows/traces
and a separate raw-derived zero-charge proof with mocked RPC/container process
creation. No fresh paid dust transaction or physical-network result is claimed.

The public suite exercises real direct-loopback Iroh using simulated payments.
Native cases cover resets and half-closes, fragmented and malformed frames, a
lost simulated receipt, multiple identities behind one source address,
same-NodeId reconnection without resetting its 30-request quota and newcomer
admission after nine disconnected free-request peers. Offline limiter tests
cover protected connected reservations, exhaustion after 256 actual admissions,
per-identity debt through LRU churn, rollover with active work, duplicate
release and partial grants. In the partial-grant case, one identity consumes 30,
seven connected identities reserve 210, and an eighth receives the remaining 16.
Releasing one reservation creates spare capacity, but the exhausted partial
lease must still refuse entry until disconnect/re-register allows its
remaining 14. This directly exercises the connected `leases > 0` guard; it is an
offline limiter result, not a new network fairness guarantee. The current public
suite uses the actual production limiter; older reduced-table diagnostics remain
historical. Both the limiter and native nine-single-request tests require the
newcomer to receive its full 30-request quota and refuse its 31st request.

A separate native egress test uses an unread receiver plus controlled packet
loss on owned loopback UDP sockets. It pauses only its owned buyer subprocess
with `SIGSTOP`, preventing IPv6 route recovery until the seller expires its
write; cleanup resumes and terminates that child. This one process-control case
explicitly skips outside macOS/Linux. It retains the actual receive handles,
observes original native write/finish promises and waits for actual finish
cleanup before the next warm-up request. It fills the send buffer across two
admission windows by advancing JavaScript `Date.now`. Native clocks and deadline
timers remain real. Seven other incomplete ingress streams keep all other slots
occupied, so a healthy request after expiry proves the stalled slot was
released. Non-reading alone did not block this SDK's buffered writes; this is a
deterministic local loss/paused-receiver experiment, not a physical-network or
payment result. Binding/IPv6 capability skips are explicit; see
[Contributing](../CONTRIBUTING.md).

The public fixture is a minimal projection of one saved finalized deposit/claim
pair: selected metadata and parsed financial instructions remain unchanged.
Public transaction signatures, account addresses and decoded creation fields
allow the actual SDK to derive the original channel PDA. The on-chain creation
nonce is public and distinct from private measurement salts. Saved finality is
replayed; the current channel account and RPC responses are explicitly
synthetic. Full-refund and positive-credit variants are unsigned modified
observations, retain the escrow rent lifecycle and preserve principal while
routing modeled token surplus to the canonical treasury before closure. These
variants were not executed on-chain; deployed-binary/source equivalence was not
verified.

Recovery cases exercise the actual CLI main workflow, role/trust loading,
ephemeral unfunded synthetic offer signing/verification, filesystem locks and
real temporary JSON persistence. RPC is mocked, and persistence-failure cases
also inject rename errors. Offer verification, locks and normal persistence
remain actual. They verify proof persistence before journal confirmation,
preservation of surplus fields, charged/conflicting proof refusal and an
unresolved journal after a persistence failure. Export cases retain the actual
container-read parser and collector while stubbing process creation, and
re-fetch zero-charge proof with the actual verifier/SDK. Their scope excludes
the spawned CLI's outer catch, chain submission, power-loss durability and
physical signed-offer recovery. Ownership/FIFO checks run only on supported
platforms and otherwise skip explicitly; owned bounded child probes protect the
test process from blocking.

Separate paid-call fault cases spawn the actual CLI entrypoint with narrowly
scoped readiness/payment-port stubs. Real locks, temporary JSON persistence,
failure handling and metric filtering remain. They cover lost responses,
truncated bodies, proof errors, post-discovery snapshot errors, hostile thrown
values and later receipt-validation failures with one simulated invocation and
no signing/RPC. Shared-buyer receipt and proof-read tests use synthetic
responses and the curated historical pair. They establish diagnostics and
conservative read handling, not a new settlement, live RPC lag or general
charged recovery.

These public checks require no private fixtures, funded keys, Docker, inference
engine or live RPC. They do not establish a fresh chain audit, public relay
compatibility, on-chain replay or exactly-once settlement. Existing charged or
missing-claim recovery, ordinary confirmed journal clearance, journal-derived
paid exports, remaining command diagnostics and broader native/Sybil/source-key/
relay/privacy limits remain follow-ups. Raw transaction responses, private logs,
measurements and evidence remain excluded. The historical physical report is
retained separately from the
[current candidate validation record](https://github.com/Gyblos/gyblos-payments/pull/10).
Only a new smoke bound to the exact final commit can validate that candidate.
Its per-request and total charge plus refund must equal the authorized ceiling.
Updating that external record leaves the tested Git revision unchanged;
historical evidence never implies a later-head paid pass. Broader lab
reorganization, typechecking of all diagnostic JavaScript and alternate-engine
rollout remain follow-up work. Measurement code can accept the explicit
allowlisted offer model identity while existing fixed-engine gates retain their
pinned default; this does not validate another engine end to end.
