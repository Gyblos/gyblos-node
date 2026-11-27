# Lab

`lab/` holds validation that runs outside the product: devnet proof-of-concept
checks (gates), synthetic acceptance runs and operational tools. Product code
never imports `lab/`. "Gate" is a lab word only; pull requests have required
checks, not gates.

| Path                     | Contents                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `lab/harness`            | `@gyblos/lab-harness`: gate commands, acceptance runs and their fixtures.                           |
| `lab/tools`              | Identity tools: `pnpm identity:fixtures` and the authorized-only `pnpm identity:devnet-run`.        |
| `lab/tools/agent-replay` | `pnpm lab:agent-replay`: an agent session against local sellers (see below).                        |
| `lab/evidence`           | Curated, redacted reports from earlier authorized runs ([Published evidence](#published-evidence)). |
| `lab/docs`               | The pages listed below.                                                                             |

## Lab pages

- [Lab acceptance runs](docs/node-discovery-acceptance.md): discovery, free
  inference, streaming, identity and receipts, all synthetic and offline.
- [Offline payment-channel program acceptance](docs/paid-native-acceptance.md):
  LiteSVM suites against the bundled program, and how to rebuild it.

[tests/README.md](../tests/README.md) lists every acceptance run and how the
offline suites report counts.

## Agent replay

`pnpm lab:agent-replay` measures what a coding agent waits for. It starts 1, 2
and 3 local free sellers and the real free buyer HTTP, all offline and on a real
clock. The sellers use a paced synthetic engine and renew on the production
tick. It then replays an OpenCode turn (3 parallel requests) and a 10-turn tool
loop.

For each request it writes a JSONL line with time to headers, time to first
token, total time, HTTP status and code, and the seller that served it. It
prints a summary with percentiles, failures and seller cooldowns.

Each run writes a new `agent-replay-<runId>.jsonl`. Its records carry the run id
and the engine mode. `--out <dir>` chooses the directory, and creates it if
needed; without it, the file goes to a new temporary directory. `--ollama` uses
the gate Ollama engine instead, so the synthetic pacing does not apply.

## Batch-settlement channel check

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
