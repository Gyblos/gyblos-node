# x402-upto-metered

Metered payments on the x402 `upto` scheme on Solana:

- the payer deposits a ceiling into a payment channel;
- the service delivers and meters what it delivered;
- settlement charges only the metered amount (possibly partial, possibly zero)
  and refunds the rest of the deposit.

Unlike the reference x402 middleware, it doesn't assume HTTP. Authorizations,
admissions and settlements are plain values that any transport can carry, for
example a QUIC peer-to-peer stream.

Status: pre-release and private (`"private": true`). The published name is
provisional.

## Requirements

- Runtime dependencies: `@x402/core`, `@x402/svm` and `@solana/kit`, at the
  versions pinned in `package.json`.
- Multi-recipient splits (`terms.splits`) and claims on `Closing` channels need
  the monorepo's patch of `@x402/svm` (`patches/@x402__svm@2.28.0.patch`). The
  rationale and upstream status sit next to the patch entry in
  `pnpm-workspace.yaml`.

## API

Every export is in `src/index.ts`.

### Payer

| Export                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createUptoHintReader`                                      | Reads the hints for signing an open offline: the latest blockhash, its last valid height and the current slot. It reads them only after the RPC proves once that it serves the terms' network.                                                                                                                                                                                                                                                          |
| `createUptoAuthorization(payer, terms, hints, beforeSign?)` | Signs the channel open with the x402 `upto` client, offline. The optional `beforeSign({ channelId, openSlot, lastValidBlockHeight })` checkpoints the exact prepared open before the payer signs: await durable storage in it, and keep the checkpoint if signing fails. Checkpoint mode accepts partial signers only, signs the original message once and verifies the returned signature. The callback never broadcasts or stores a reusable payload. |
| `uptoClaimUntil(authorization)`                             | The claim deadline from the SDK-validated payload expiry. That expiry is not part of the payer-signed open.                                                                                                                                                                                                                                                                                                                                             |
| `createUptoChannelHistory`                                  | What finalized history says about a channel address: the finalized tip, its successful transactions oldest first, the oldest slot the RPC serves, and whether the account exists. For reconciliation.                                                                                                                                                                                                                                                   |
| `createUptoReceiptReader`                                   | The payer's view of a channel transaction from token balances: a deposit that funded the escrow, or a final claim that emptied it, with what payTo, the fee treasury and the payer received.                                                                                                                                                                                                                                                            |
| `createUptoWithdrawal`                                      | The payer's way out of a stuck channel; see [Withdrawal](#withdrawal).                                                                                                                                                                                                                                                                                                                                                                                  |
| `parseUptoWithdrawalAttempt`                                | Validates saved withdrawal metadata before recovery.                                                                                                                                                                                                                                                                                                                                                                                                    |

### Seller

| Export                                                      | What it does                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createUptoVerifier(feePayerAddress, currentSlot)`          | Verifies an open against the terms, with no network call besides the current-slot source. It needs only the fee payer's address.                                                                                                                                                                                                                  |
| `createUptoSeller({ chain, store, now, own })`              | The seller's write-ahead state machine. Admission verifies, records `depositing`, deposits once and records `admitted`. Settlement records `settling` with the one charge, claims once and records `settled`; a retry with the same charge returns that settlement. `recover()` resolves records a crash left between a chain call and its write. |
| `createUptoSdkChain(options)`                               | The `UptoChain` over the SDK facilitator: deposit, a claim signed by the seller's authorizer, outcomes classified as refused or possibly landed, and claims idempotent per channel and charge through a durable `UptoChainStore` and an on-chain lookup.                                                                                          |
| `createUptoFacilitator(signer, store)`                      | Builds the SDK facilitator with its pending signatures kept in `store`, and opts into claims on `Closing` channels before the grace ends. The unconfigured SDK stays Open-only.                                                                                                                                                                   |
| `createUptoChannelReaders`, `uptoChannelRpc`                | Read the seller's own channels through a minimal RPC: whether a channel exists, and whether a claim attempt landed or the channel was sealed for another amount.                                                                                                                                                                                  |
| `createUptoRecipientAccounts`, `uptoRecipientTokenAccounts` | Make the token accounts a claim pays into exist before the seller charges (payTo, fee treasury, payee and the payer's refund account), at the fee payer's cost. A missing account would send its share to the program treasury for good.                                                                                                          |
| `uptoRequirements(terms)`                                   | The shared x402 payment requirements for a set of terms.                                                                                                                                                                                                                                                                                          |
| `decodeUptoPayload`                                         | The bounded authorization payload decoder.                                                                                                                                                                                                                                                                                                        |

Terms always come from the seller's own offer, never from the payer's request.

### Stores

The host supplies `UptoStore` (channel records) and `UptoChainStore` (pending
claim signatures). Both must survive crashes; the SDK alone doesn't keep claims
idempotent across a restart.

- `memoryUptoStore()` and `memoryUptoChainStore()` are in-memory stores for
  tests and single-process use.
- `durablePendingStore(store)` adapts an `UptoChainStore` to the SDK's pending
  settlement store, so a recorded pending signature survives a restart and is
  awaited instead of sent again.

Durable file stores are not part of this package: it imports no Gyblos code. In
the Gyblos monorepo, `packages/payments-upto` supplies them.

### Program instructions

`requestCloseInstruction`, `sealInstruction`, `distributeInstruction`,
`tokenAccountInstruction`, `payerTokenAccountInstruction`,
`uptoDistributionHash`, `uptoTokenAccount` and `uptoProgramTreasury` encode the
payment-channels program instructions and addresses as the SDK's generated
client does; the SDK doesn't export these builders. A test compares every byte
with the SDK.

### Constants and errors

`UPTO`, `UPTO_CHANNEL_STATES`, `UPTO_WITHDRAW_STEPS`, `UPTO_PROGRAM` and the
other `UPTO_*` constants, plus `UptoError` and `uptoError`.

## Withdrawal

`createUptoWithdrawal` takes the payer one step at a time from confirmed native
channel state:

1. Select the step: request close, wait for the grace, then seal and distribute.
2. Sign the transaction and derive its signature from the signed bytes.
3. Save the signature and original blockhash lifetime through the optional
   recovery context's durable `save` callback. A failed save stops the send.
4. Broadcast. A lost or mismatched RPC reply returns the signature unconfirmed,
   without resending. A definitive preflight or chain rejection throws
   `UPTO_CHAIN_REJECTED`.
5. Observe. Recovery with the last `UptoWithdrawalAttempt` reads the historical
   signature status and finalized, context-bound channel state. It never sends a
   replacement in the same call that resolves a pending attempt.

Guarantees and duties:

- Confirmation describes transaction status, not a verified refund amount; use
  finalized receipt and history checks for that.
- Nonfinal or unavailable observations stay uncertain.
- Hosts keep resolved metadata to avoid stale bank views, and serialize their
  compare-and-set writes.
- Durable mode needs a partial signer; modifying or sending-only wallets are
  refused.
- The same sender creates recipient accounts, where an unconfirmed send still
  refuses admission.

## Rules

- No dependency on any Gyblos package.
- Every failure is an `UptoError` whose message is a static code from
  `UPTO_ERROR_CODES` (for example `UPTO_CHAIN_REJECTED`, `UPTO_UNAVAILABLE`,
  `UPTO_JOURNAL_UNAVAILABLE`). RPC URLs, keys and upstream text never appear in
  it.

## Development

From the monorepo root:

```sh
pnpm --filter x402-upto-metered test
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
