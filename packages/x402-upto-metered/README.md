# x402-upto-metered

Status: pre-release and private. The published name is provisional.

Metered payments on top of the x402 `upto` scheme on Solana:

- the payer deposits a ceiling into a payment channel;
- the service delivers and meters what it delivered;
- settlement charges only the metered amount (possibly partial, possibly 0) and
  refunds the rest of the deposit.

Unlike the reference x402 middleware, it does not assume HTTP: authorizations,
admissions and settlements are plain values that any transport can carry (for
example a QUIC peer-to-peer stream).

## What exists today

- `createUptoAuthorization(payer, terms, hints)`: the payer signs the channel
  open with the x402 upto client, offline given recent-block hints. An optional
  fourth argument, `beforeSign({ channelId, openSlot, lastValidBlockHeight })`,
  checkpoints that exact prepared open before invoking the payer. Await durable
  storage in this callback and retain the checkpoint if signing later fails.
  Checkpoint mode accepts partial signers only, signs the original message once
  and verifies the returned payer signature; modifying or sending signers are
  refused. Without the callback, the existing SDK signer behavior is preserved.
  The callback neither broadcasts nor stores a reusable authorization payload.
- `createUptoVerifier(feePayerAddress, currentSlot)`: the x402 upto facilitator
  verifies an open against the terms with no network call other than the
  current-slot source; it needs only the fee payer's address.
- `createUptoSeller({ chain, store, now, own })`: the seller's write-ahead state
  machine. Admission verifies, records `depositing`, deposits once and records
  `admitted`; settlement records `settling` with the one charge, claims once and
  records `settled`, and same-charge retries return that settlement. `recover()`
  resolves records a crash left between a chain call and its write. The host
  supplies `UptoChain` (claims idempotent per channel and charge and kept
  durably across crashes, which the SDK alone does not do) and `UptoStore`;
  `memoryUptoStore()` is an in-memory store, `uptoRequirements(terms)` the
  shared x402 requirements, and `decodeUptoPayload` the bounded payload decoder.
- Terms come from the seller's own offer, never from the buyer's request.

- `createUptoSdkChain(...)`: the `UptoChain` over the SDK's facilitator settle:
  deposit, voucher-signed claim by the seller's authorizer, outcomes classified
  (refused vs. may-have-landed), and claims idempotent per channel and charge
  through a durable `UptoChainStore` and an on-chain lookup of the sealing
  transaction; `createUptoFacilitator(signer, store)` builds the facilitator
  with its pending signatures kept in that store.
- `terms.splits` distributes each charge between payTo and further recipients
  (for example a protocol fee). This needs the monorepo's patch of
  `@x402/svm@2.28.0` (`patches/@x402__svm@2.28.0.patch`); not yet proposed
  upstream.

The payer's `createUptoWithdrawal` selects request-close, wait, seal/distribute
from confirmed native channel state. Its shared transaction sender derives the
signature from the signed bytes before broadcast. A lost or mismatched RPC send
reply returns that signature unconfirmed, without resending. A definitive
preflight/chain rejection still throws `UPTO_CHAIN_REJECTED`. Confirmation
describes transaction status, not a verified refund amount; use finalized
receipt/history verification for that. An optional per-call recovery context
supplies a durable `save` callback and the last `UptoWithdrawalAttempt`. The SDK
saves the local signature and original blockhash lifetime before broadcast; a
failed save prevents sending. Recovery reads historical signature status and
finalized, context-bound channel state, and never sends a replacement in the
same call that resolves a pending attempt. Nonfinal or unavailable observations
remain uncertain. Hosts retain resolved metadata to prevent stale bank views,
and must serialize compare-and-set writes. Durable mode requires a partial
signer; modifying/sending-only wallets are refused. The same sender serves
recipient-account creation, where an unconfirmed send still refuses admission.

Planned: a durable file store and the host wiring.

## Rules

- No dependency on any Gyblos package. The only runtime dependencies are the
  x402 SDK (`@x402/core`, `@x402/svm`) and `@solana/kit`.
- Every failure is an `UptoError` whose message is a static code
  (`UPTO_ERROR_CODES`); RPC URLs, keys and upstream text never appear in it.

## Development

From the monorepo root: `pnpm --filter x402-upto-metered test`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
