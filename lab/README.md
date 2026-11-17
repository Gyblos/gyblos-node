# Lab

`lab/` holds validation that runs outside the product: devnet proof-of-concept
checks (gates), synthetic acceptance runs, a standalone facilitator and
operational tools. Product code never imports `lab/`. "Gate" is a lab word only;
pull requests have required checks, not gates.

| Path              | Contents                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `lab/harness`     | `@gyblos/lab-harness`: gate commands, acceptance runs and their fixtures.                           |
| `lab/facilitator` | `@gyblos/lab-facilitator`: the v1 facilitator as a standalone loopback service.                     |
| `lab/tools`       | Identity tools: `pnpm identity:fixtures` and the authorized-only `pnpm identity:devnet-run`.        |
| `lab/evidence`    | Curated, redacted reports from earlier authorized runs ([Published evidence](#published-evidence)). |
| `lab/docs`        | The pages listed below.                                                                             |

## Lab pages

- [Lab acceptance runs](docs/node-discovery-acceptance.md): discovery, free
  inference, streaming, identity and receipts, all synthetic and offline.
- [Simulated paid startup acceptance](docs/paid-acceptance.md):
  `pnpm acceptance:paid`, the paid seller and buyer against a simulated chain.
- [Offline payment-channel program acceptance](docs/paid-native-acceptance.md):
  LiteSVM suites against the bundled program, and how to rebuild it.
- [Lab inference gate](docs/inference-gate.md): `pnpm gate:inference`, metered
  inference with a real model on devnet.

[tests/README.md](../tests/README.md) lists every acceptance run and how the
offline suites report counts.

## Acceptance runs and gates

Acceptance runs are offline and synthetic: run them freely, and they run in CI
through `pnpm test:lab`. Gates are different.

Gates send real devnet transactions from funded lab wallets. They are
operational actions: run one only when it is explicitly authorized, and never to
validate a change. A local 402 answer or a passing test is not proof of an
on-chain paid run.

## Gates

Gates live in `lab/harness`. The `exact` scheme and the fixed-price test seller
exist only here. Run them from the repository root after setup and funding;
network confirmation can take minutes.

| Command               | What it proves                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm gate:preflight` | Devnet, program, mint and balances are ready.                                                                     |
| `pnpm gate:challenge` | An unpaid request returns 402 without running the resource or paying.                                             |
| `pnpm gate:run`       | A full `upto` payment: 10,000 deposited, 4,000 charged, 6,000 returned, buyer SOL unchanged.                      |
| `pnpm gate:failures`  | An empty buyer and an expired authorization are both refused without a charge (about 62 s).                       |
| `pnpm gate:exact`     | A fixed-price payment through a public facilitator; network, mint, amount, recipient and fee payer checked first. |
| `pnpm gate:inference` | Six metered-inference cases with a real model; see [Lab inference gate](docs/inference-gate.md).                  |
| `pnpm gate:channel`   | One reusable channel for several requests, with the protocol fee split on chain; see below.                       |

### Setup and assets

1. `pnpm gate:setup` creates isolated buyer, seller, authorizer, facilitator and
   test-mint keys in the lab home (`.local/lab/`, or `GYBLOS_LAB_HOME`). It
   never overwrites existing keys.
2. Fund the lab wallets with `pnpm gate:fund`. With `--test-mint` it also
   creates the lab test token, labelled `devnet-test-token` (not USDC).
   Rerunning it does not mint more when the mint exists.
3. `pnpm gate:preflight` confirms everything is ready.

The `upto` gates use the lab test token. The product uses Circle devnet USDC;
the test token exists only for gates. Amounts are atomic units of a six-decimal
token.

`gate:exact` pays 10,000 atomic units (0.01 Circle devnet USDC) for a fixed
resource through `x402.org`, with PayAI as the configured backup; the public
facilitator pays the transaction fee. Get devnet USDC from the
[Circle faucet](https://faucet.circle.com). The accepted mint is `DEVNET_USDC`
in `packages/config/src/network.ts`.

To run the fixed-resource roles in separate terminals, start
`pnpm gate:facilitator` (port 4022) and `pnpm gate:seller` (port 4021), then run
`pnpm gate:buyer`.

Gate reports for `exact` and inference are written to
`lab/evidence/gate-0004.json` and `gate-0005.json`. Git ignores those paths;
they are never published.

### Batch-settlement channel check

`pnpm gate:channel` exercises the SDK's `batch-settlement` scheme directly
against the official payment-channel program (`CHANNEL_PROGRAM` in
`packages/config/src/network.ts`), outside the node:

1. The buyer deposits 5,000 once.
2. It pays three requests (145, 210 and 95) with metered vouchers signed by the
   seller's operator key.
3. The seller redeems them in one claim and distribution.
4. The buyer gets the rest back with a cooperative refund.

The check fails unless the seller receives 96% of the 450 charged (rounded
down), the Gyblos treasury 4% (rounded down), the program treasury the rounding
remainder, the refund is 4,550 and the buyer spends no SOL. This check takes the
fee out of the seller's charge with a flat 96/4 split. Product payment sessions
use the same scheme with their own fee arithmetic; see
[payment-sessions.md](../docs/payment-sessions.md).

The fee is committed when the channel opens, through `extra.splits` (seller
first, then the treasury; one to four distinct recipients, basis points summing
to 10,000). The buyer's client opens such a channel only if its `approveSplits`
callback accepts the exact list. Without `extra.splits` the SDK pays 100% to
`payTo`. This comes from the local `@x402/svm` patch, proposed upstream in
[x402-foundation/x402#4166](https://github.com/x402-foundation/x402/issues/4166);
its justification is next to the patch entry in `pnpm-workspace.yaml`.

By default the check needs a loopback validator (Agave 4.x; Solana 1.18 cannot
run the program) loaded with the program dumped from devnet:

```sh
solana program dump -u devnet CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX channels.so
solana-test-validator --reset --bpf-program CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX channels.so
pnpm gate:channel
```

It uses throwaway keys and a fresh test mint.

`pnpm gate:channel --devnet` runs against the public devnet RPC and sends real
devnet transactions, so run it only when approved. It keeps its keys in
`.local/lab/batch-channel-check/keys.json` (mode `0600`; a more open file is
refused). Only the funder key needs devnet SOL; when it has none, the check
prints the funder address and exits with code 2.

## Local facilitator

The v1 facilitator settles lab payment channels. The gates run it, and
`pnpm gate:facilitator` (`lab/facilitator`) runs it on its own. It signs and
pays for settlement with its own devnet key and keeps channel state in memory
only. The product's paid seller does not use it: it runs its own facilitator in
process, with a durable ledger.

It writes private diagnostics as JSONL to `.local/lab/facilitator-diagnostics/`:

- files use mode `0600` and the directory `0700`; keep them out of Git;
- records hold only allowlisted fields: SDK version, attempt, operation, phase,
  stage and bounded channel, amount and signature hints, never raw errors,
  prompts, payloads or RPC URLs;
- storage is bounded: 128 queued records, 4 KiB per record, 4 MiB per file,
  three rotations per process and 16 files (64 MiB), deleting the oldest file
  when full, so copy anything you need to keep;
- `GET /facilitator/diagnostics` on the loopback facilitator shows health and
  counters.

Logging never blocks or changes a payment, and a diagnostic record is not proof
of settlement, refund or delivery.

Every lab HTTP server (facilitator, sellers, buyer) binds to `127.0.0.1` and
answers only when `Host` is `127.0.0.1`, `localhost` or `[::1]` with the exact
port; anything else gets an empty `421`. This blocks DNS-rebinding reads from a
browser. It is not authentication against other local processes.

## Legacy v1 buyer

The paid v1 buyer is a loopback proxy that pays a trusted seller through its
signed `offer.json`. The seller daemon never writes that file, so the v1 flow
runs only against the lab gates. The product buyer is `pnpm buyer` (see
[running-a-node.md](../docs/running-a-node.md#buyer)).

### Set up and start

1. Create the buyer role with the mint you will pay in. For a product role this
   is devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`; the gates
   name their own test token.

   ```sh
   pnpm node:setup --role buyer --mint MINT
   ```

2. Download and verify the pinned tokenizer (`pnpm buyer:setup` does the same).
   It writes public files to `<home>/artifacts/tokenizer/` and does not install
   Ollama, download weights, read keys or contact Solana.

   ```sh
   pnpm node:tokenizer
   ```

3. Copy the seller's `<home>/seller/offer.json` into `<home>/buyer/`.
4. Confirm the seller's owner, NodeId and payout address independently, then
   record them:

   ```sh
   pnpm buyer:trust --owner SELLER_OWNER_ADDRESS --node-id SELLER_NODE_ID --pay-to PAYOUT_ADDRESS --max-atomic 10000
   ```

   The command checks the offer's signature, lifetime, payment terms and relay
   against those identities and the local buyer and mint. It creates
   `trust.json` and refuses to overwrite an existing one. It never derives trust
   from the offer by itself and makes no payment.

5. Fund the buyer address with `MINT` using your own Solana tooling. No command
   funds roles.
6. Start the proxy:

   ```sh
   pnpm buyer:start
   ```

`trust.json` names the seller you trust; every field must match the offer:

```json
{
  "owner": "SELLER_OWNER_ADDRESS",
  "nodeId": "SELLER_NODE_ID",
  "mint": "MINT",
  "payTo": "PAYOUT_ADDRESS",
  "buyer": "BUYER_ADDRESS",
  "maxAtomic": "10000"
}
```

### Proxy behavior

- It listens on `127.0.0.1:4031` and accepts only `POST /v1/chat/completions`
  with a loopback `Host`.
- It runs one request at a time: a second waits and a third gets `429`.
  Malformed JSON gets `400 MALFORMED_JSON`.
- A transport failure returns `503` and is treated as an uncertain payment. It
  is never retried.
- A seller other than the trusted one gets `SELECTED_SELLER_NOT_TRUSTED` (HTTP
  409), with no inference or payment. Quotes are never converted into v1:
  execution needs reasoning `off` and terms that match the stored offer exactly,
  otherwise `QUOTE_REQUIRES_UNSUPPORTED_V2_EXECUTION`. This entry never runs
  free requests.
- The signed follow-up must match the original request ID and exact body. A lost
  authorized response blocks routing until reconciliation resolves it;
  restarting the proxy is not reconciliation. The proxy keeps at most 1,024
  decisions in memory, retaining authorized IDs to prevent replay until restart.

`pnpm buyer:call 0` sends one synthetic paid call (case `0`, `1` or `2`) through
a running proxy and records journals and measurements in `<home>/buyer/`.
`pnpm buyer:reconcile` verifies or clears a zero-charge v1 payment; see
[Legacy paid v1 recovery](../docs/recovery.md#legacy-paid-v1-recovery).

### v1 files and variables

| Name                    | Purpose                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trust.json`            | The trusted seller, written by `buyer:trust`.                                                                                                        |
| `offer.json`            | The seller's signed v1 offer, copied in by hand.                                                                                                     |
| `authorization.json`    | The payment journal for the call in progress.                                                                                                        |
| `calls.json`            | Records of synthetic calls from `buyer:call`.                                                                                                        |
| `GYBLOS_EXPECTED_ROUTE` | `iroh-direct` or `iroh-relay`: refuse to pay when the observed route differs. It doesn't hide the buyer's address; `GYBLOS_BUYER_RELAY_ONLY=1` does. |
| `GYBLOS_P2P_RUN_ID`     | Optional label copied into journals and evidence.                                                                                                    |

### Lab ports

The lab gates run their own Ollama on `11436` (`11437` during setup) and their
seller on `4021`. The paid v1 path also uses the loopback paid seller on `4032`
and the facilitator on `4022`. Facilitator diagnostics are covered under
[Local facilitator](#local-facilitator).

## Published evidence

Only three curated, redacted reports are committed in `lab/evidence/`:

| Report           | What it shows                                                                           |
| ---------------- | --------------------------------------------------------------------------------------- |
| `gate-0006.json` | Docker lab: flat network and relay passed; Docker NAT-direct did not.                   |
| `gate-0007.json` | Earlier native attempts between a Mac and a VPS (historical).                           |
| `gate-0008.json` | Three sequential paid inferences between a Mac seller and a VPS buyer over direct Iroh. |

They contain public signatures, amounts and route categories only: no keys,
prompts, answers, IP addresses, RPC URLs or raw logs. What these runs prove, and
what they don't, is in [limitations.md](../docs/limitations.md).

When a payment outcome is unclear, see [recovery.md](../docs/recovery.md).
