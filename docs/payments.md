# Payments

Gyblos buyers pay sellers on Solana **devnet**, in Circle devnet USDC, through
x402 payment channels. Devnet USDC has no market value, and the product refuses
mainnet. A free offer needs no payment at all.

This page is the contributor overview of the payment paths. To charge for an
offer as a seller operator, follow
[Get paid](https://docs.gyblos.com/en/sellers/get-paid) on the docs site. Lab
channel checks and historical evidence are in [lab/README.md](../lab/README.md).

## Payment paths

The signed quote decides the path. Both prices `"0"` means free; any positive
price means paid. The buyer's `request.maxAtomic` is a spending ceiling, not a
mode switch (see [Buyer routing](payment-sessions.md#buyer-routing)).

| Path            | Who uses it                            | Channel                                      | Owner page                                 |
| --------------- | -------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| Free            | Any seller and buyer                   | None: no signer, deposit or settlement       | [running-a-node.md](running-a-node.md)     |
| Payment session | Authenticated buyers of a priced offer | x402 `batch-settlement`: one deposit, reused | [payment-sessions.md](payment-sessions.md) |

The desktop and guided buyer use a payment session for priced quotes. Existing
profiles with a positive ceiling require the
[session settings](payment-sessions.md#explicit-startup-policy).

## Seller-sponsored channel transaction limits

Paid-v2 channel openings, top-ups and SDK settlement signing share
`PAYMENT_TRANSACTION_LIMITS` in `packages/config/src/payment-fees.ts`: at most
400,000 compute units, 5,000 micro-lamports per compute unit and two required
signatures. An explicit positive compute-unit limit is mandatory; duplicate,
malformed or unsupported compute-budget instructions and lookup-table messages
are refused before the seller signs. Omitting the price means zero priority fee.
Both SDK signing APIs are guarded, including the message-signing path used for
buyer-supplied opens and the transaction-signing path used for settlement. One
message is signed without these bounds: the SDK's pre-submission simulation of
open, settle and distribute, which uses the transaction maximum (1,400,000
compute units) and the all-zero placeholder blockhash. No recent blockhash or
durable nonce is zero, so that message can never be broadcast. A buyer's opening
wire is admitted only within the bounds, whatever its blockhash. Without this,
the seller could reject its own simulation before submitting the deposit on that
attempt. Confirmed chain state determines the outcome of any earlier attempt.

These are per-transaction instruction and signer-count bounds, not a total
wallet, daily SOL, token-account creation or rent budget. The priority component
is at most 2,000 lamports per guarded transaction; network base fees remain
separate. Existing SDK-generated openings and settlements fit these limits. A
recovery retains the original recorded attempt: a refusal never clears
uncertainty or rebuilds a channel. The independent standalone SDK wrapper
accepts optional host limits and keeps its unconfigured defaults. The legacy v1
path and the protocol commission are unchanged.

For channel settlement and refunds, see [Payment sessions](payment-sessions.md)
and [Recovery](recovery.md).

## Protocol fee

The fee is 4% (`PROTOCOL_FEE` in `packages/config/src/network.ts`). It is added
on top of the seller's net price, not taken out of it:

- The buyer sees and pays the gross price per million tokens: the net price
  times 1.04, rounded up to a whole atomic unit (`grossAtomicPerMtok` in
  `packages/protocol/src/payment-binding.ts`).
- Each charge is split on chain between the payout address and the treasury
  (`paymentSplits`). The seller's basis points are rounded up, and the program
  floors each payout. The rounding residual goes to the payment program's own
  treasury, so the fee Gyblos collects is approximate, not exactly 4%.

The devnet treasury is a public Gyblos test wallet (`DEVNET_GYBLOS_TREASURY`).

## Asset and network

- Product payments use Circle devnet USDC (`DEVNET_USDC` in
  `packages/config/src/network.ts`). `install.sh` sets up the seller with that
  mint, and `pnpm buyer:init` sets up the buyer with it. Amounts are atomic
  units of a six-decimal token, so `1000000` is 1 USDC.
- The lab gates use their own test token instead; see
  [lab/README.md](../lab/README.md).
- The x402 SDK versions and the local `@x402/svm` patch are pinned in
  `package.json` and `pnpm-workspace.yaml`, which also explains the patch.

## Where the code lives

The [package table](architecture.md#packages) owns the details. In short:

- `packages/protocol`: payment ports (`PaymentClient`, `PaymentServer`), the
  payment binding (terms digest, memo, gross price, splits) and the paid and
  session wire contracts.
- `packages/x402-upto-metered`: the standalone metered `upto` library; see its
  [README](../packages/x402-upto-metered/README.md).
- `packages/payments-upto`: the `PaymentServer` adapter over it, the durable
  seller ledger in the seller's `payments/` directory, and payment sessions.
- `packages/node`: opens the seller channel registry and serves paid inference
  over reusable sessions.

## Related

- [Payment sessions](payment-sessions.md)
- [Recovery and reconciliation](recovery.md)
- [Known limitations](limitations.md#payments-and-recovery)
- [Get paid](https://docs.gyblos.com/en/sellers/get-paid) (seller operators)
