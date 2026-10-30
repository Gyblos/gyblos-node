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
  open with the x402 upto client, offline given recent-block hints.
- `createUptoVerifier(feePayerAddress, currentSlot)`: the x402 upto facilitator
  verifies an open against the terms with no network call other than the
  current-slot source; it needs only the fee payer's address.
- `createUptoSeller({ chain, store, now, own })`: the seller's write-ahead state
  machine. Admission verifies, records `depositing`, deposits once and records
  `admitted`; settlement records `settling` with the one charge, claims once and
  records `settled`, and same-charge retries return that settlement. `recover()`
  resolves records a crash left between a chain call and its write. The host
  supplies `UptoChain` (with idempotent claims) and `UptoStore`;
  `memoryUptoStore()` is an in-memory store, `uptoRequirements(terms)` the
  shared x402 requirements, and `decodeUptoPayload` the bounded payload decoder.
- Terms come from the seller's own offer, never from the buyer's request.

Planned: the chain implementation that deposits and claims through the SDK, a
durable store, and multi-recipient splits.

## Rules

- No dependency on any Gyblos package. The only runtime dependencies are the
  x402 SDK (`@x402/core`, `@x402/svm`) and `@solana/kit`.
- Every failure is an `UptoError` whose message is a static code
  (`UPTO_ERROR_CODES`); RPC URLs, keys and upstream text never appear in it.

## Development

From the monorepo root: `pnpm --filter x402-upto-metered test`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
