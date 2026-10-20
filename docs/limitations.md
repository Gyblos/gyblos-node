# Limitations and recovery

This repository is an experimental TypeScript x402 payment foundation for
Gyblos. It exercises Solana devnet fixed resources and a local Ollama inference
gate, plus an experimental native Iroh PoC. One native Wi-Fi Mac–VPS direct
trial completed three paid devnet requests at source `2c8eeac`, using a test SPL
mint, not USDC. Broader NAT/hotspot/CGNAT coverage and subsequent-head physical
validation remain pending. Use isolated generated devnet wallets only. Never
import mainnet keys.

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
limited to one per NodeId. Connected peers reserve their available per-minute
allowance within the shared budget of 256 requests. Free challenges from other
peers cannot spend that reservation. A peer with admitted work retains unused
quota after disconnect until the current fixed window ends, so its authenticated
NodeId can reconnect while other peers consume unreserved capacity. Zero-work
connections release unused quota. Reconnection retains consumed debt and may
refill a partial allowance only from available shared capacity. Active,
connected and reserved entries cannot be evicted by LRU; rollover expires
inactive grace and refreshes connected reservations. Inactive unreserved
eviction can reset per-peer history. A request qualifies for grace before the
origin outcome, so a free challenge or failed work can earn it. Nine disposable
NodeIds can each make one free request, disconnect and encumber all 256 shared
admissions: nine consumed and 247 reserved, with no live attacker connection.
New unreserved identities are refused until rollover; already-reserved peers can
still reconnect. The original release policy required 256 admissions to exhaust
the same budget. A real direct-loopback Iroh comparison reproduces this
regression; it remains unresolved. This is not paid history, costly identity or
production fairness. A payment header grants no priority.

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
credits between the selected transactions and later channel credits do not
invalidate an otherwise consistent proof. Every selected transaction must still
conserve its exact sponsor/channel/escrow deltas against its fee. Negative
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
Current wallets never supply historical token balances. Prefunding, token dust
and arbitrary additional transaction shapes are outside this correction.

This verifier is deliberately limited to fresh, individually settled channels
with retained canonical accounts. Closed/missing channels, nonfinalized data,
unexplained transaction-local deltas or unsupported shapes stop verification. It
does not recover rent or guarantee recovery from every crash. Evidence export
re-fetches proof for zero-charge reconciliations and binds their ceiling to the
original attempt. Confirmed paid rows still come from the call journal.
Source/image provenance is separate from chain truth and remains explicitly
unverified when supplied by an operator.

The current corrections were validated with private offline regressions,
controlled process/filesystem failures and real direct-loopback Iroh using
simulated payments. The native cases cover resets and half-closes, fragmented
and malformed frames, a lost simulated receipt, multiple identities behind one
source address and same-NodeId reconnection after verified free-challenge
pressure. Financial regressions replay unchanged historical transactions with
explicitly synthetic current-channel and RPC responses through the real SDK
verifier; synthetic full-refund variants retain the escrow rent lifecycle.
Positive-credit cases also exercise the actual zero-charge reconciliation
function and CLI main workflow with mocked role/offer boundaries and RPC, plus a
wrapper forwarding persistence to real temporary JSON files. They verify proof
persistence before journal confirmation, charged/depleted proof refusal and
failure to persist proof leaving the journal unresolved. They do not exercise
the spawned CLI's outer catch, real offer verification or chain submission.
Ownership tests include the actual macOS domain and mocked Linux/macOS probes.
These checks are not a fresh chain audit, public relay test, on-chain replay
proof or exactly-once settlement proof. All new test/evidence artifacts remain
outside Git. The original physical payment evidence still belongs to `2c8eeac`.
No later-head paid run is implied. Broader lab reorganization, typechecking of
all diagnostic JavaScript and alternate-engine rollout remain follow-up work.
Measurement code can now accept the explicit allowlisted offer model identity,
while existing fixed-engine gates retain their pinned default; this does not
validate another engine end to end.
