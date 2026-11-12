# Reusable buyer-authorized payment sessions

The shared buyer and seller session services use the pinned Solana x402
`batch-settlement` client-signature mode. Trusted hosts can compose them over
the opt-in `gyblos/session/3` Iroh channel. The buyer CLI and seller daemon can
activate this path explicitly. Without that policy, the existing per-request
path remains available. No public gateway is enabled by this composition.

## Conversation input and compatibility

Reusable sessions accept the shared text conversation shape: optional system
first, then alternating user/assistant turns ending with the user's turn. The
complete history is sent with each request and counted by the model's chat
template on both peers. Earlier turns are input tokens again on later requests;
channel reuse avoids a new deposit, not payment for input the engine processes.
No server-side conversation history is stored. The existing 64 KiB content,
1024-message and 128-output-token bounds, signed quote, context and budget all
apply; unsupported input is rejected rather than trimmed.

The active session transport is v3. Old session-v1/v2 peers must be upgraded;
failed v3 preparation signs no opening and does not trigger a fallback. The SDK
channel and private financial journal do not migrate: saved approvals retain
their original digest and recover without another inference. The per-request
paid stream remains a separate, single-user path. Free wire contracts are
unchanged. Reusable sessions opt into prompt cancellation of deadline-bounded
generation, stopping publication even if an engine ignores abort. Legacy free
and per-request paid paths retain their delivery-measurement timing. Execution
replies carry ordered text fragments and one correlated complete terminal.
Streaming API callers receive fragments as the engine produces them;
complete-response callers drain and verify the same wire without publishing
fragments. No final text is replayed after streaming. Every frame, the aggregate
encoded response and the number of events are bounded. Waiting for the next
engine event uses the original absolute request deadline; after its first byte,
an incomplete prefix or body keeps the ingress deadline. The terminal's text
must equal all observed fragments, and EOF is required before usage approval.
Earlier v1/v2 vectors remain unchanged.

Cancellation before a fully verified terminal creates no new usage approval. It
stops publication, aborts generation on connection close and preserves the
pending financial intent; the prompt is never replayed. The seller can collect
only its highest already accepted cumulative signature, so the last unsigned
response remains bounded seller exposure. Once independently verified usage
enters durable approval, cancellation cannot revoke that intent: recover only
the original bill/voucher, including a lost ACK. Passing time alone does not
clear uncertainty. Tools remain separate from this shared streaming transport.

## Terminal conversation history

`pnpm buyer:chat` keeps confirmed user/assistant turns in memory and sends the
whole conversation with the next question. It retains the assistant's exact text
only after the local stream has a valid completion, its terminal marker and EOF.
Partial text is provisional. A cut or uncertain result ends the chat; the prompt
is never resent, including when more input was already queued.

Use `/new` to clear only the current conversation. It sends no request, closes
no channel, resets no spending authority and clears no pending financial
operation. `/settle` and `/exit` retain their existing meanings. Starting the
process again begins with empty conversation history while financial recovery
still uses its original private state. This feature adds no prompt/answer file
or content logging.

The existing terminal input limit of 64000 UTF-8 bytes now applies to the entire
history plus the new question, within the common 1024-message limit. History is
never silently shortened. If it no longer fits, the terminal rejects the next
question before making a request and suggests `/new`. A completed answer may fit
the existing output bound but make the next conversation too large; it is still
displayed. Full-history tokenization, context and signed budget checks remain
the shared buyer/seller policy, so previous turns cost input tokens again.

Free offers and reusable paid sessions support this history. The legacy
per-request paid path still accepts only a single user message: it refuses a
multi-turn paid request rather than flattening it or falling back. Use `/new`
for separate questions on that path, or configure the existing reusable-session
policy for paid conversations. Selection and financial authorization are
unchanged.

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
priced execution service exposes this ALPN. Without total authority there is one
private session per role; the optional
[shared-authority mode](#multiple-sellers-and-shared-authority) keeps one
bounded slot per chosen seller, not per arbitrary remote buyer. Preparation is
stateless; only a valid SDK opening proof can assign that slot. Restart restores
its original terms, absolute expiry, pending operations and worker. Changing
selection or limits does not replace that session. Remove neither its files nor
its lock to unblock a request. A completed channel is retained; automatic
rotation is not provided. Reusable financial startup is currently unavailable on
Windows until the payment subtree has equivalent ACL validation. Existing paths
retain their behavior.

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

Without shared total authority startup retains one pair. Explicit total
authority enables separately owned seller sessions as described below.
Concurrent requests inside one seller channel, automatic session rotation/topup,
restored-journal rollback defense, abrupt host/power-loss acceptance and live
network/deployed-program validation remain separate work.

## Multiple sellers and shared authority

Add `totalDepositAtomic` to the existing buyer `session` policy to enable the
private multi-seller catalog. `depositAtomic` remains the fixed amount per new
seller channel; `totalDepositAtomic` is the authorization shared by all of them.
For example, a per-channel deposit of `"100000"` and total authority of
`"200000"` can fund two sellers. Omitting the total retains the existing
single-channel mode; no larger authority is inferred from the candidate list.
Both amounts use canonical atomic decimal strings. The per-channel pilot cap,
finite lifetime and withdrawal grace remain unchanged.

The normal verified selector chooses a seller, and the shared buyer routes its
signed quote to that seller's persistent slot. Returning A → B → A reuses A's
original channel and cumulative total, including after restarting the buyer.
Changing a seller's owner, payment identities, network, asset or channel terms
cannot replace the old slot. All slots share the same buyer, buyer NodeId,
network and asset. There are at most sixteen slots, including retained closed
ones. With total authority, at most two requests may execute concurrently
against different sellers, reusing the existing global limit; each seller
channel remains single-request. Admissions and durable financial catalog
mutations are serialized, not generation. This does not add automatic topup,
channel rotation or new model/API formats.

Committed authority is the sum of each allocated deposit minus its independently
verified refund. An idle, expired, opening or uncertain channel still occupies
its full allocation. Actual charges remain consumed after settlement; refunds
are credited once, survive restart and cannot reset prior spending. Lowering the
configured total below commitments blocks new use, while recovery and closure
under original terms remain available. `/settle` tries every retained seller and
reports aggregate charge/refund amounts only when all required independent
proofs exist. A failed/offline peer cannot fabricate a successful aggregate or
prevent attempts to close the other slots.

Every buyer service startup mode (free, per-request, single-session and pool)
first holds the same buyer-home lifetime ownership guard. Startup failures,
final inspection and shutdown release it. Raw signing/SDK ports remain trusted
host primitives; external hosts must honor that ownership contract. The adapter
additionally holds one buyer-wide catalog process lock and writes an allocation
before financial construction or signing. It seeds a private child journal
before marking that slot ready, so an interrupted pre-sign allocation can finish
under the same immutable reservation. A missing ready journal fails closed. A
durable request intent precedes execution: ambiguity blocks new free and paid
routing across all sellers until original financial approval recovery or
independent finality resolves it. A provably pristine pre-sign child may clear a
failed intent without releasing its allocation. Prompt content is never
replayed.

The catalog and deterministic child paths live under the buyer's private
payments home, using 0700 directories, 0600 files, bounded atomic writes and
strict parsers. A pre-existing root single-channel journal is adopted in place
and counted before another allocation; it is never moved or overwritten.
Removing pool configuration cannot bypass non-finalized obligations. Updated
applications must exclusively own this home; running an older binary against the
same financial state is unsupported. This is not protection against restoring a
complete older backup; that remains separate work.

Zero-price signed quotes still use transaction-free execution. A fresh free-only
buyer with pool policy constructs no financial backend, loads no signing key and
makes no financial RPC call. Identity/discovery checks retain their existing
policy. Windows reusable financial activation remains unavailable.

## Buyer routing when a selected seller is busy

The optional `routing` object in buyer `selection.json` is validated by the
shared `@gyblos/core/buyer-routing` policy and consumed by the shared session
runtime. Other hosts can reuse its parser and the node routing service; no
Settings UI is included here. Configuration is loaded at buyer startup.

```json
{
  "routing": {
    "onBusy": "reroute",
    "allowPinnedFallback": false,
    "allowHigherPriceFallback": false,
    "queueWaitMs": 30000
  }
}
```

`reroute` is the default. `reject` returns busy without another execution. A
fixed seller is replaced only when `allowPinnedFallback` is explicitly true.
These options govern a seller already chosen or pinned, not the initial ranking.
The third option, `wait`, waits for that same seller with a bounded in-memory
queue. Without shared total session authority, existing buyer modes retain their
behavior.

Before rerouting, both replacement prices must be no higher than the original
verified quote or fresh authenticated catalog, independently for input and
output. An occupied local seller uses the quote held by its active request as
the reference while that verified quote remains valid; querying its control
channel would compete with its unchanged per-peer execution admission. An
expired or missing active reference returns typed busy. This reference only
bounds prices: the alternative still passes fresh identity, replay, selection
and quote checks. User ceilings are intersected with those prices. Explicit
higher-price permission still cannot widen the configured price, per-request or
total budget. With the default price rule, a free quote cannot turn into a paid
request. An unverifiable or expired reference cannot authorize fallback.
Identity, replay, exact model, reasoning, network and asset checks remain
mandatory for each alternative.

Rerouting ends before the first possible prompt write: a failed or partial
write, remote execution refusal or lost response never sends that prompt
elsewhere. Only explicit busy before transmission and a safely unused financial
intent can be treated as an unsent busy result. A busy response after a prompt
was written remains terminal. No retries are added to execution.

Live ownership is distinct from unknown financial state. An owned healthy A
request does not trigger recovery or block B. If A becomes uncertain, new free
and paid requests stop. B may finish under its original reservation if its
prompt was already sent; otherwise B is cancelled before transmission. Restart
never reconstructs live ownership from a pending journal: original recovery is
required. Settlement/reconciliation refuse while requests are active. Shutdown
closes admission and drains actual operations before releasing private journal
ownership.

## Waiting for the selected seller

`routing.onBusy: "wait"` never reroutes. It admits at most one waiter per seller
within the existing two-request total admission, including waiting HTTP calls.
Two running calls therefore leave no third queue slot; one running A call can
have one waiter. This does not increase HTTP, Iroh, engine or financial
capacity. Waiting occupies neither an execution connection nor a new financial
reservation. Existing channel deposits remain committed. Queue data, including
its captured input, exists only in memory and is never restored or replayed
after restart.

The default wait is 30000 milliseconds. `queueWaitMs` must be a positive integer
no greater than the existing request deadline, and the original caller deadline
may end the wait sooner. A waiter is removed on disconnect, cancellation,
uncertainty, shutdown or expiry; timeout has a static typed local error. FIFO
ownership is handed to the waiter before a newcomer can acquire that seller.

After admission, the buyer obtains a new quote for the same seller and repeats
identity, freshness, model/reasoning and budget checks. When a quote was already
selected, its input and output prices also bound the renewed quote unless
higher-price fallback was explicitly authorized. Waiting never silently turns a
free choice into a paid one. Only a known busy cooldown is ignored for this
explicit retry; hard filters still apply. No deposit or request authorization
starts while the request is still queued. If the remote peer remains busy,
bounded control-only polls share the original wait deadline. A non-busy failure
ends the call; it never changes sellers or retries a prompt.

The trusted execution port receives a synchronous `sending` callback. Product
free and session transports invoke it at the actual first possible prompt write,
after checks. It ends the queue clock, preserving the original remaining
response deadline without extending it. Preparation and quote renewal remain
bounded by queue time. A failed/partial write is still a possible send and never
retried. Usage approval and final settlement retain their existing independent
checks.

Settings controls belong to the separate host/UI integration. The canonical
parser and behavior below apps are reusable; this implementation changes no
desktop panel, seller CLI, fee calculation, wire bytes or journal format.
