# Reusable buyer-authorized payment sessions

The shared buyer and seller session services use the pinned Solana x402
`batch-settlement` client-signature mode. They are library composition ports for
trusted hosts. The default buyer CLI and seller daemon still use their existing
per-request payment path; this module does not register another inference ALPN,
change an existing execution wire, or expose a public gateway.

## Ownership and trust

`@gyblos/protocol/payment-session` defines the SDK-independent ports.
`@gyblos/payments-upto/batch-session` owns SDK construction,
synthetic-independent signers, bounded private journals, and the seller timer.
`@gyblos/node/batch-session` composes admission, the existing execution
lifecycle, independent buyer usage verification and post-delivery approval.
Hosts provide existing identity/quote/input verification and authenticated
transport. They must also enforce the existing unresolved-payment barrier. These
are trusted ports, not untrusted callbacks obtained from discovery.

Each session fixes buyer wallet and NodeId, seller owner and NodeId, network,
asset, payout, fee payer, receiver authorizer, fee distribution, deposit and
host expiry. The buyer signs these terms in the opening memo. The SDK's on-chain
voucher authorizer is the buyer, not the seller's receiver-authorizer key.
Mainnet is refused by this first implementation. Native tests use synthetic keys
and an isolated test-network label with the source-pinned program in LiteSVM.

## Lifecycle

1. Persist the original opening hints and salt before any opening signature.
   Open one bounded deposit with a buyer-signed zero voucher and no advance
   charge. The narrowly opt-in SDK helper patch preserves default behavior.
2. Reserve a request's ceiling before generating. Request identifiers/digests
   are single-use. Stage one admits one unfinished request per session;
   reservations are individual records, rather than an embedded single-request
   channel.
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
keys. An unavailable write poisons that handle; ambiguity is never cleared to
proceed.

If the buyer disappears before approving the final response, the seller can
collect only the previous signed total. Exposure is bounded to one request.
Signature recovery reuses the already independently approved bill; it cannot
restart generation. The seller may renew its own expired close authorization,
keeping the buyer voucher, cumulative amount and SDK pending transaction records
unchanged.

Host transport must bound frames, authenticate the chosen peers, propagate
cancellation and expose uncertainty. This library is not a new transport or an
assertion of coding-agent API compatibility. Multiple sellers/concurrent
requests, restored-journal rollback defense, abrupt host/power-loss acceptance
and live network/deployed-program validation remain separate work.
