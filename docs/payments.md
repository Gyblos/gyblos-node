# Payments

The x402 integration uses the official SDK on Solana devnet: core, Express and
fetch are pinned to 2.29.0, while SVM remains at 2.28.0 with the local patch.
Amounts are in atomic units of a six-decimal token.

## Two schemes

| Scheme  | What the buyer pays                       | Facilitator                           | Used for              |
| ------- | ----------------------------------------- | ------------------------------------- | --------------------- |
| `upto`  | Reported usage, within a signed ceiling   | Local process in this repo            | Metered inference     |
| `exact` | A fixed price; no refund of unused budget | x402.org (PayAI as configured backup) | A fixed test resource |

**`upto`** works through a payment channel. The buyer signs a ceiling and
deposits it; after the work the facilitator settles the channel, paying the
seller its charge and returning the rest to the buyer. The buyer independently
recounts tokens and flags overcharges, but this does **not** prevent a dishonest
charge within the ceiling.

**`exact`** pays 10,000 atomic units (0.01 Circle devnet USDC) for a fixed
resource. The public facilitator pays the transaction fee. Get devnet USDC from
the [Circle faucet](https://faucet.circle.com); the accepted mint is
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

The `upto` gates and the node use a test token labelled `devnet-test-token`,
**not USDC**, created by `pnpm gate:fund --test-mint`.

## Gates

Gates are proof-of-concept checks in `lab/harness`; the `exact` scheme and the
fixed-price test seller exist only there. Run them from the repository root
after `pnpm gate:setup` and funding; network confirmation can take minutes.

| Command               | What it proves                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm gate:preflight` | Devnet, program, mint and balances are ready.                                                                |
| `pnpm gate:challenge` | An unpaid request returns 402 without running the resource or paying.                                        |
| `pnpm gate:run`       | Full `upto` payment: 10,000 deposited, 4,000 charged, 6,000 returned, buyer SOL unchanged.                   |
| `pnpm gate:failures`  | An empty buyer and an expired authorization are both refused without a charge (about 62 s).                  |
| `pnpm gate:exact`     | Fixed-price payment through x402.org: network, mint, amount, recipient and fee payer checked before signing. |
| `pnpm gate:inference` | Six metered-inference cases with a real model; see [inference.md](inference.md).                             |
| `pnpm gate:channel`   | One long-lived channel for several requests, with the protocol fee split on chain; see below.                |

`gate:setup` creates isolated buyer, seller, authorizer, facilitator and
test-mint keys in the lab home (`.local/lab/`, or `GYBLOS_LAB_HOME`) and never
overwrites existing keys. Rerunning `gate:fund --test-mint` does not mint more
tokens when the mint already exists.

To run the fixed-resource roles in separate terminals: `pnpm gate:facilitator`
(port 4022), `pnpm gate:seller` (port 4021), then `pnpm gate:buyer`.

Gate reports for `exact` and inference are written locally to
`lab/evidence/gate-0004.json` and `gate-0005.json`. These paths are ignored by
Git; those reports are not published.

## Batch-settlement channel check

Today the node opens one `upto` channel per request, so every request pays its
own transactions and rent. `pnpm gate:channel` checks the alternative with the
SDK's `batch-settlement` scheme and the official payment-channels program
(`CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`): the buyer deposits 5,000 once,
pays three requests (145, 210 and 95) with metered vouchers signed by the
seller's operator key, the seller redeems them in one claim and distribution,
and the buyer gets the rest back with a cooperative refund. The check fails
unless the seller receives 97% of the 450 charged (rounded down), the treasury
3% (rounded down), the program treasury the rounding remainder, the refund is
4,550 and the buyer spends no SOL. It is not wired into the buyer or seller.

The protocol fee is committed when the channel opens, through `extra.splits`
(seller first, then the treasury; 1–4 distinct recipients, basis points summing
to 10,000). The buyer's client opens such a channel only if its `approveSplits`
callback accepts the exact list. Without `extra.splits` the SDK keeps paying
100% to `payTo`. This part comes from the local `@x402/svm` patch, proposed
upstream in
[x402-foundation/x402#4166](https://github.com/x402-foundation/x402/issues/4166).
Here the fee comes out of the seller's charge, unlike `upto`, where it is added
on top of the seller's price.

Before this replaces `upto` in the node:

- The splits are fixed for the channel's life, and the facilitator checks every
  voucher, top-up, claim and refund against the splits of the current terms.
  Changing the fee or treasury while a channel is open makes it unusable until
  the buyer withdraws; close channels before changing them.
- The facilitator's channel storage must be durable and keep each channel's
  splits; otherwise, after a restart, rent cleanup builds a 100% `payTo`
  distribution that the program rejects.
- Every recipient needs a token account for the mint before redemption.

By default the check needs a loopback validator (Agave 4.x; Solana 1.18 cannot
run the program) that loads the program dumped from devnet:

```sh
solana program dump -u devnet CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX channels.so
solana-test-validator --reset --bpf-program CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX channels.so
pnpm gate:channel
```

It uses throwaway keys and a fresh test mint. `pnpm gate:channel --devnet` runs
on the public devnet RPC; it sends real devnet transactions, so run it only when
approved. It keeps its keys in `.local/lab/batch-channel-check/keys.json` (mode
`0600`; a more open file is refused), and only the funder key needs devnet SOL;
when it has none, the check prints the funder address and exits with code 2.

## Published evidence

Only three curated, redacted reports are committed in `lab/evidence/`:

| Report           | What it shows                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `gate-0006.json` | Docker lab: flat network and relay passed; Docker NAT-direct did not.                               |
| `gate-0007.json` | Earlier native Mac–VPS attempts (historical).                                                       |
| `gate-0008.json` | Three sequential paid inferences, Mac seller and VPS buyer, direct Iroh, bound to source `ba168c4`. |

They contain public signatures, amounts and route categories only: no keys,
prompts, answers, IPs, RPC URLs or raw logs.

## Local facilitator

The v1 facilitator (run by the lab gates; `lab/facilitator` runs it standalone
for lab checks) signs and pays for channel settlement with its own devnet key.
It keeps channel state in memory; there is no durable channel storage. The paid
v2 seller daemon runs the facilitator in process instead, with its fee payer key
and the durable upto ledger in `seller/payments/`.

It writes private diagnostics as JSONL to `.local/lab/facilitator-diagnostics/`:

- Files are mode `0600`, the directory `0700`. Keep them out of Git.
- Records hold only allowlisted fields: SDK version, attempt, operation, phase,
  stage and bounded channel/amount/signature hints. No raw errors, prompts,
  payloads or RPC URLs.
- Size is bounded: 128 queued records, 4 KiB per record, 4 MiB per file, 3
  rotations per process, 16 files (64 MiB). When full, the oldest file is
  deleted, so copy anything you need to keep.
- `GET /facilitator/diagnostics` on the loopback facilitator shows health and
  counters.
- Logging never blocks or changes a payment. A diagnostic record is not proof of
  settlement, refund or delivery.

## Loopback servers

All HTTP servers here (facilitator, sellers, buyer proxy) bind to `127.0.0.1`
and answer only when `Host` is `127.0.0.1`, `localhost` or `[::1]` with the
exact port; anything else gets an empty 421. This blocks DNS-rebinding reads
from a browser. It is not authentication against other local processes.

For what happens when a payment outcome is unclear, see
[recovery.md](recovery.md).
