# Reusable buyer-authorized payment sessions

The shared buyer and seller session services use the pinned Solana x402
`batch-settlement` client-signature mode. Trusted hosts can compose them over
the opt-in `gyblos/session/1` Iroh channel. The buyer CLI and seller daemon can
activate this path explicitly. Without that policy, the existing per-request
path remains available. No public gateway is enabled by this composition.

## Explicit startup policy

Add a `session` object to the buyer's existing `buyer/selection.json`:

```json
{
  "session": {
    "depositAtomic": "1000000",
    "lifetimeMs": 3600000,
    "withdrawDelaySeconds": 900
  }
}
```

This is an additional field in the existing document, not a replacement for its
selection, identity and per-request budget fields. Deposit must be positive and
at most 1000000 atomic units (1 USDC); lifetime is five minutes to 24 hours;
withdrawal grace is 900 to 3600 seconds (900 if omitted). `maxAtomic` still
limits each question. A request cannot exceed the session's remaining unreserved
funds. The canonical protocol fee and treasury still come from `PROTOCOL_FEE`;
the remote peer cannot change them.

The seller opts in by setting `GYBLOS_SESSION_BUYER_NODE_ID` to the one
permitted buyer's lowercase NodeId before normal startup. Only a seller with a
priced execution service exposes this ALPN. There is one private session per
role, not one slot per arbitrary remote peer. Preparation is stateless; only a
valid SDK opening proof can assign that slot. Restart restores its original
terms, absolute expiry, pending operations and worker. Changing selection or
limits does not replace that session. Remove neither its files nor its lock to
unblock a request. A completed channel is retained; automatic rotation is not
provided. Reusable financial startup is currently unavailable on Windows until
the payment subtree has equivalent ACL validation. Existing paths retain their
behavior.

Start the buyer normally with `pnpm buyer:chat`. It distinguishes the session
deposit, each question's ceiling and its independently verified **approved**
cumulative usage. Approval is not a finalized on-chain charge. `/exit` closes
the local connection; the seller worker continues. `/settle` requests final
closure and prints amounts only after independent finalized evidence; if closure
already happened it reads that evidence without requiring the seller to be
online. A missing proof remains pending. A lost approval acknowledgment blocks
new inference until the exact financial approval is recovered; recovery never
sends the prompt again. A free signed quote uses the existing free path and
constructs no financial backend, even with session policy present.

## Ownership and trust

`@gyblos/protocol/payment-session` defines the SDK-independent ports.
`@gyblos/payments-upto/batch-session` owns SDK construction,
synthetic-independent signers, bounded private journals, and the seller timer.
`@gyblos/node/batch-session` composes admission, the existing execution
lifecycle, independent buyer usage verification and post-delivery approval.
`@gyblos/node/batch-buyer` connects an already chosen seller to independent
quote verification, recounting and the session buyer. It plugs into the shared
`executeBuyerQuote` paid port; zero-price offers still use its free port.
`@gyblos/node/batch-seller` selects an exact warmed paid offer and runs its
engine through the shared lifecycle. `serveSellerTransport` accepts this service
as `batchSessions`; `bindEndpoint` advertises it only with
`batchSessions: true`. `@gyblos/transport-iroh/batch-client` and `batch-server`
own authenticated, bounded Iroh I/O and existing endpoint admission, without
payment SDKs or engines.

Hosts provision one matching buyer/seller session and provide the existing
independent identity/catalog/request/budget verification and finalized-chain
observers. The buyer checks the unresolved-payment barrier before any opening.
These are trusted ports, never callbacks supplied by discovery. This initial
composition does not negotiate arbitrary deposits or create per-peer journals
for unknown buyers. Before the buyer calls its opening/signing port, it uses
`prepare` with its full independently authorized terms to check that the
authenticated seller supports the session channel and agrees to those exact
terms. Every field must match the buyer's independently authorized and persisted
terms, including deposit, expiry, withdrawal delay, treasury and fee. A
different term or unsupported peer fails before a new opening signature. The
seller's preparation reply performs no financial operation or engine call.
Policy, quote time and cancellation are checked again after the reply;
preparation cannot replace a prior uncertain opening or approval. This is a
compatibility/agreement check; it does not authorize public buyers or reserve
the seller slot.

Each session fixes buyer wallet and NodeId, seller owner and NodeId, network,
asset, payout, fee payer, receiver authorizer, fee distribution, deposit and
host expiry. The buyer signs these terms in the opening memo. The SDK's on-chain
voucher authorizer is the buyer, not the seller's receiver-authorizer key.
Mainnet terms are refused by this first implementation. Hosts must independently
verify RPC genesis before providing chain signers or observations. Native tests
use synthetic keys and an isolated test-network label with the source-pinned
program in LiteSVM.

## Lifecycle

1. Persist the original opening hints and salt before any opening signature. On
   a lost opening response, the trusted host must prove the finalized original
   signed opening message and exact live channel bindings; mere account
   existence is insufficient. The SDK then verifies the live buyer voucher
   before recovery. Open one bounded deposit with a buyer-signed zero voucher
   and no advance charge. The narrowly opt-in SDK helper patch preserves default
   behavior.
2. Verify the live funded channel with the SDK, then reserve a request's ceiling
   before generating. Request identifiers/digests are single-use. Stage one
   admits one unfinished request per session; reservations are individual
   records, rather than an embedded single-request channel.
3. Measure delivered usage through the common seller execution lifecycle. Save a
   bill containing the request binding, actual charge and cumulative amount.
4. Independently verify received usage and prices on the buyer. Persist the
   approved bill before signing its cumulative voucher. The seller verifies that
   signature with the SDK and persists it before acknowledging it.
5. Only that acknowledgement permits the buyer's next request. A lost
   acknowledgement retries the same financial approval, never the prompt.
6. On closure, freeze admissions and the highest accepted voucher. The seller's
   fee payer submits the SDK cooperative refund, or seals a buyer-forced Closing
   channel within its grace period, and refunds unused escrow. The host must
   independently confirm the resulting transaction and amounts before marking
   the journal closed.

One finalization may require multiple transactions. There are no intermediate
payment transactions for each inference. This service performs no automatic
topup, channel rotation, seller failover or shared-balance operation.

## Autonomous policy

Defaults live in `@gyblos/config/batch-session`: ten-minute inactivity, 10000
atomic units (0.01 USDC) as a soft accumulated-charge threshold, and a fifteen
second worker tick. The threshold is provisional, not measured profitability or
a minimum charge. Below it, ordinary idle closure waits for host expiry.
Explicit closure, deposit exhaustion, the request-record bound, host expiry,
buyer-forced close, and an abandoned unsigned final response bypass the
threshold. A host must observe buyer-forced closure every tick; a missing or
failed observation does not become evidence that the channel remains open.

Batch SDK requires at least 900 seconds of withdrawal grace. Existing
per-request `upto` parameters remain unchanged. Batch buyer vouchers use the
SDK's non-expiring zero sentinel. Host expiry stops serving and triggers an
actual close operation; it does not make funds return by the passage of time.
Both parties being offline still prevents transaction submission. A seller
offline beyond forced-close grace can lose earnings not yet submitted on chain.

The seller pays normal finalization gas and fronts rent from its fee payer.
Buyer emergency recovery is separate; sponsored recovery is not newly promised.
The existing canonical protocol fee and split arithmetic remain unchanged.

## Failure and persistence boundaries

Journals are private, size-bounded, atomically replaced and process-locked in
the role's payments directory, with 0700 directories and 0600 files. They retain
SDK pending operations and the highest voucher, without prompts, answers or
keys. Before persisting a first remote opening, the adapter rejects unknown SDK
fields, enforces an 8 KiB opening bound and the SDK Solana transaction-size
bound, and verifies the buyer's initial SDK proof. Invalid data cannot pin or
overflow the journal; legitimate lost-opening recovery retains its original
checkpoint. An unavailable write poisons that handle; ambiguity is never cleared
to proceed.

If the buyer disappears before approving the final response, the seller can
collect only the previous signed total. Exposure is bounded to one request.
Signature recovery reuses the already independently approved bill; it cannot
restart generation. The seller may renew its own expired close authorization,
keeping the buyer voucher, cumulative amount and SDK pending transaction records
unchanged.

The optional Iroh composition authenticates the chosen peers, bounds frames and
absolute deadlines, propagates cancellation and marks possible transmission
before the first write. Native reads/writes retain their admission lease until
settled after cancellation. An expired quote is refused again immediately before
transmission. A transport error never retries the prompt. Explicit approval
recovery resends only the already independently verified cumulative financial
approval; its ACK must name the exact cumulative total and zero reservation.
Remote status is metadata, and a remote close response becomes financial proof
only after the buyer's own chain observation.

## Iroh execution scope

One bidirectional stream carries one canonical request/reply; the connection can
serve sequential RPCs while the financial session survives disconnection. The
operations are `prepare`, `open`, `execute`, `approve`, `snapshot` and `close`,
defined in the [wire specification](../packages/protocol/SPEC.md). Both endpoint
connection/rate admission and request quotas apply before the session's own
single-active-call budget. The seller worker belongs to the financial service,
not the connection; closing the buyer's connection does not stop autonomous
settlement.

This channel returns a complete response for one user message with reasoning
off. The local chat receives one complete verified answer, exposed as one
awaited SSE delta; this is not token streaming. Unsupported inputs are refused
before the buyer signs an opening; there is no fallback to another seller or
payment path after possible prompt transmission. The buyer recounts usage and
charges at the signed quote's existing per-million rates before signing. A
partial or missing terminal produces no new approval; the seller can collect
only its earlier accepted total. Existing free/paid stream channels remain
independently available; no streaming or full agent-API compatibility is newly
claimed for this session RPC.

Explicit application startup activates the single permitted pair only. Multiple
sellers/concurrent requests, automatic session rotation/topup, restored-journal
rollback defense, abrupt host/power-loss acceptance and live
network/deployed-program validation remain separate work.
