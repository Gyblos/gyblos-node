# Payments

Gyblos buyers pay sellers on Solana **devnet**, in Circle devnet USDC, through
x402 payment channels. Devnet USDC has no market value, and the product refuses
mainnet. A free offer needs no payment at all.

This page is the contributor overview of the payment paths. To charge for an
offer as a seller operator, follow
[Get paid](https://docs.gyblos.com/en/sellers/get-paid) on the docs site. Lab
checks (gates, the local v1 facilitator and the published evidence) are in
[lab/README.md](../lab/README.md).

## Payment paths

The signed quote decides the path. Both prices `"0"` means free; any positive
price means paid. The buyer's `request.maxAtomic` is a spending ceiling, not a
mode switch (see [Buyer routing](payment-sessions.md#buyer-routing)).

| Path               | Who uses it                            | Channel                                      | Owner page                                 |
| ------------------ | -------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| Free               | Any seller and buyer                   | None: no signer, deposit or settlement       | [running-a-node.md](running-a-node.md)     |
| Per-request paid   | Any priced offer (the default)         | x402 `upto`: one channel per request         | This page and [recovery.md](recovery.md)   |
| Payment session    | Allowlisted seller–buyer pairs (pilot) | x402 `batch-settlement`: one deposit, reused | [payment-sessions.md](payment-sessions.md) |
| `exact`, v1 `upto` | Lab gates only                         | Fixed-price resource, legacy PoC facilitator | [lab/README.md](../lab/README.md)          |

Per-request paid serves text conversations without tools. Tools on a priced
offer need a payment session.

## How a per-request payment works

1. The buyer verifies the seller's signed quote, then signs a channel open whose
   deposit is the request's ceiling. It records the opening in its private
   journal before it signs.
2. The seller verifies the open against its own offer terms, never against the
   buyer's request. Its fee payer submits the deposit and pays the transaction
   fees and the channel rent.
3. The seller runs the inference and meters the output with the model's pinned
   tokenizer. It stops publishing text that the deposit can't pay for.
4. The seller claims the metered charge with a voucher signed by its authorizer
   key. The channel pays the seller's payout address and the Gyblos treasury,
   and refunds the rest of the deposit to the buyer.
5. The buyer recounts the tokens and checks the charge against finalized chain
   history. A charge that differs from its own count is recorded as a dispute.

A recount **detects** an overcharge within the ceiling. It does not prevent,
refund or penalize it.

An unclear outcome (a timeout, a lost reply, a missing history entry) never
counts as "no payment". It blocks new payments until it is reconciled; see
[recovery.md](recovery.md). The buyer resolves its paid channels with
`pnpm buyer:reconcile:paid` and takes a stuck channel toward a refund with
`pnpm buyer:withdraw:paid`.

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
- Per-request channels and payment sessions use the same arithmetic.

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
- `packages/node`: composes paid execution when the seller has a payment server.

## Related

- [Payment sessions](payment-sessions.md)
- [Recovery and reconciliation](recovery.md)
- [Known limitations](limitations.md#payments-and-recovery)
- [Get paid](https://docs.gyblos.com/en/sellers/get-paid) (seller operators)
