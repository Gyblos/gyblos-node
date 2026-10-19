# Gyblos Payments

Experimental x402 payments for Gyblos, a P2P inference project. A buyer
authorizes a budget, a seller reports token usage, and a facilitator settles the
charge and returns the unused deposit on Solana. This repository runs
fixed-resource checks and local Ollama inference; it does not yet connect P2P
nodes.

> **Status:** experimental, Solana **devnet** only. Not audited. Never use
> mainnet keys. Part of [Gyblos](https://gyblos.com) ·
> [Paper](https://gyblos.com/paper).

## How it works

```text
buyer (CLI) ── requests / receives 402 terms ──▶ seller (HTTP + Ollama)
     │ signs a ceiling                              │ reports usage
     ▼                                              ▼
facilitator ── opens & settles a Solana payment channel
                    └── seller paid; unused deposit returned to buyer
```

| Route   | Payment                                 | Facilitator                 | Use                 |
| ------- | --------------------------------------- | --------------------------- | ------------------- |
| `upto`  | Reported usage, within a signed ceiling | Local process in this repo  | Metered inference   |
| `exact` | Fixed price; no unused-budget refund    | x402.org, with PayAI backup | Fixed test resource |

Both routes use the official `@x402/*` SDK pinned to 2.28.0. The buyer
independently recounts inference tokens and detects discrepancies; this does
**not** prevent a dishonest charge within the signed ceiling. The quickstart
uses a test token, **not USDC**; the public fixed-price route uses Circle devnet
USDC.

## Quickstart: make a fixed-resource payment

Requirements: Node.js 22+, pnpm 10.12.1 and access to a Solana devnet RPC. Run
from the repository root. Funding and network confirmation can take several
minutes.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm gate:setup
# Fund the printed facilitator address with at least 0.05 devnet SOL:
# https://faucet.solana.com
pnpm gate:fund --test-mint
pnpm gate:preflight
pnpm gate:challenge
pnpm gate:run
```

Wallet setup creates isolated buyer, seller, authorizer, facilitator and
test-mint keys in `.local/devnet/`, preserving existing keys. If configuration
already exists, find the facilitator address in its `addresses.facilitator`
field. Provisioning creates a six-decimal SPL test token and accounts; rerunning
it does not mint more tokens when the mint already exists.

The preflight checks devnet, the program, mint and funding. The unpaid challenge
must return HTTP 402 without executing the resource or settling a payment. The
full run starts both hosts and verifies distinct confirmed open/claim
transactions: **10,000 deposited, 4,000 charged, 6,000 returned**, matching
token balances, unchanged buyer SOL, channel distribution and fixed-resource
delivery.

## Run metered inference

Install the Ollama executable and complete the wallet/token setup above first.
Stop other gate hosts, then download the pinned model and run the six cases:

```sh
pnpm gate:inference:setup
pnpm gate:inference
```

Setup downloads Qwen3 0.6B Q4_K_M (about 523 MB of model layers) into
`.local/ollama/models/` and verifies pinned tokenizer artifacts. The gate runs
three honest calls, a deliberately inflated bill, a deliberately reduced bill
and an engine interruption. The buyer checks token counts against a predefined
tolerance.

Measurements append to `.local/devnet/measurements.jsonl` without prompts or
answers. Pricing, tokenization, case classification and measurement details are
in [docs/inference.md](docs/inference.md).

## Pay through a public facilitator

Request **USDC on Solana Devnet** from the
[Circle faucet](https://faucet.circle.com) for the generated buyer address. The
accepted mint is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

```sh
pnpm gate:exact
```

This serves a fixed resource on an ephemeral loopback port for **10,000 atomic
units (0.01 devnet USDC)**. The local wallet provisions token accounts; the
public facilitator pays the payment transaction fee. No local facilitator is
started. The buyer checks network, mint, amount, recipient and fee payer before
signing.

The seller explicitly verifies and settles before executing the resource. The
gate checks confirmation, balance changes, unchanged buyer SOL and replay
rejection. It also rejects untrusted terms and an empty buyer before signing.
Provider selection and uncertainty handling:
[known limits](docs/limitations.md).

## Other commands

Use these after setup. For separate fixed-resource hosts, start the facilitator
and seller in their own terminals, then run the buyer in a third terminal.

| Command                 | Task                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm gate:failures`    | Check insufficient funds and expiry; expiry alone waits about 62 s, plus RPC/setup time. |
| `pnpm gate:facilitator` | Start the local `upto` facilitator.                                                      |
| `pnpm gate:seller`      | Start the fixed-resource seller.                                                         |
| `pnpm gate:buyer`       | Execute the fixed-resource buyer against running local hosts.                            |
| `pnpm lint`             | Check source conventions and formatting.                                                 |
| `pnpm typecheck`        | Check TypeScript types.                                                                  |
| `pnpm format`           | Apply formatting and sort imports.                                                       |
| `pnpm format:check`     | Check formatting without changing files.                                                 |

The failure checks require the configured test SPL token. Formatting uses
Prettier with two-space indentation, an 80-column target and wrapped Markdown
prose; `.editorconfig` supplies matching basic editor settings.

## Configuration

| Variable             | Default and behavior                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `GYBLOS_GATE_CONFIG` | `.local/devnet/config.json`, resolved from the working directory.                                  |
| `GYBLOS_RPC_URL`     | Overrides the config's `rpcUrl`; setup initially saves `https://api.devnet.solana.com` when unset. |

Commands do not load `.env` automatically. Changing the config path does not
move journals, measurements or model artifacts; inference requires the isolated
key paths under `.local/devnet/`. Devnet identity is checked using its genesis
hash. Never include keys in logs or shared results.

All hosts bind to loopback (`127.0.0.1`). Fixed-resource seller: **4021**; local
facilitator: **4022**; gate-owned Ollama: **11436**, or **11437** during model
setup. Inference and public fixed-price sellers use ephemeral ports. Child
Ollama processes use the local model directory and have cloud inference
disabled.

## Project structure

```text
packages/
  config/            @gyblos/config: hosts, paths, networks, limits, versions
  runtime/           @gyblos/runtime: processes, shutdown and atomic JSON
  gate/              @gyblos/gate: setup, funding, journals and gate utilities
  application/       Reusable workflow, accounting and measurement policy
  payments-x402/     upto/exact adapters, trust policies and chain reads
  inference-ollama/  Local generation and pinned public tokenization
apps/
  cli/src/           Runnable CLI composition and result reporting
    inference/       Inference cases, evidence and reconciliation
    exact/           Public-facilitator cases, evidence and reconciliation
  seller/            Fixed-resource, public exact and inference HTTP hosts
  facilitator/       Local upto facilitator
scripts/             Thin setup, funding and compatibility entrypoints
```

## Safety and known limits

- Timeouts are **not** refunds. Uncertain payments block new ones until
  reconciled on-chain.
- Do not delete `.local/devnet/buyer.lock` or a journal to retry; inspect the
  authorization and transactions first.
- Signed seller receipts, model verification, buyer-facing streaming and mainnet
  are not implemented.

Read [docs/limitations.md](docs/limitations.md) for recovery and the full scope.
Contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).
