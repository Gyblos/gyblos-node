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

- `createUptoAuthorization`: the payer signs the channel open with the x402 upto
  client, offline given recent-block hints.
- `createUptoVerifier`: the x402 upto facilitator verifies an open against the
  terms with no network call.
- `createUptoSeller`: the seller's state machine (verify, write ahead, deposit
  once; settle one charge, write ahead, claim once, idempotent retries) over an
  injected `UptoChain` and `UptoStore`.

Planned: the chain implementation that deposits and claims through the SDK, a
durable store, recovery, and multi-recipient splits.

## Rules

- No dependency on any Gyblos package. The only runtime dependencies allowed are
  the x402 and Solana SDKs (none yet).
- Every failure is an `UptoError` whose message is a static code
  (`UPTO_ERROR_CODES`); RPC URLs, keys and upstream text never appear in it.

## Development

From the monorepo root: `pnpm --filter x402-upto-metered test`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
