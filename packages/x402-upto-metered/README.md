# x402-upto-metered

Status: pre-release and private. The published name is provisional. Today the
package contains only its error codes; everything under "Planned" is not
implemented yet.

## Planned

Metered payments on top of the x402 `upto` scheme on Solana:

- the payer deposits a ceiling into a payment channel;
- the service delivers and meters what it delivered;
- settlement charges only the metered amount (possibly partial, possibly 0) and
  refunds the rest of the deposit.

Unlike the reference x402 middleware, it will not assume HTTP: authorizations,
admissions and settlements will be plain values that any transport can carry
(for example a QUIC peer-to-peer stream).

## Rules

- No dependency on any Gyblos package. The only runtime dependencies allowed are
  the x402 and Solana SDKs (none yet).
- Every failure is an `UptoError` whose message is a static code
  (`UPTO_ERROR_CODES`); RPC URLs, keys and upstream text never appear in it.

## Development

From the monorepo root: `pnpm --filter x402-upto-metered test`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
