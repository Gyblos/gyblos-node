# Gyblos Node

Peer-to-peer inference with pay-per-use payments. The buyer signs a spending
ceiling, the seller charges only the tokens it used, and the unused deposit goes
back to the buyer.

> **Status:** experimental, Solana **devnet** only. Not audited. Never use
> mainnet keys. Part of [Gyblos](https://gyblos.com) ·
> [Paper](https://gyblos.com/paper).

## What it does

- **Seller node** (`pnpm node:start`): Ollama + signed offer, served over Iroh.
- **Buyer proxy** (`pnpm buyer:start`): checks the offer, listens on `:4031`.
- **Payments**: x402 `upto`, local facilitator, devnet test token (not USDC).
- **Transport**: Iroh over our relay `na1.relay.gyblos.com`, or direct.
- **Identity**: 8004 registry adapter in `packages/identity`, **not wired** yet.

```text
app ─▶ buyer proxy ══ Iroh (direct or na1 relay) ══▶ seller node ─▶ Ollama
        signs ceiling ─▶ Solana devnet channel ◀─ facilitator settles usage
```

## Status

- **Paid on devnet:** three sequential inferences, VPS buyer to Mac seller over
  direct Iroh ([gate-0008.json](lab/evidence/gate-0008.json), source `ba168c4`).
- **Offline on every change:** payments, recovery, transport, relay config.
- **Not tested:** paid runs on this head, relay-only privacy off-host, CGNAT,
  mainnet ([all limits](docs/limitations.md)).

## Quickstart

Requirements: Node.js 22+, pnpm 10.12.1 and a native Iroh platform (macOS ARM64
or Linux x64/ARM64; no Intel Mac, Windows untested). Paid runs need devnet SOL
from [faucet.solana.com](https://faucet.solana.com); inference needs
[Ollama](https://ollama.com).

### 1. Offline checks

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck && pnpm lint && pnpm test
```

No wallet, model or network needed; unsupported native cases skip explicitly.

### 2. A devnet payment on one machine

```sh
pnpm gate:setup              # creates isolated keys in .local/devnet/
# fund the printed facilitator address with at least 0.05 devnet SOL
pnpm gate:fund --test-mint   # creates the six-decimal test token
pnpm gate:preflight          # checks devnet, program, mint and funding
pnpm gate:challenge          # unpaid request must get HTTP 402
pnpm gate:run                # 10,000 deposited, 4,000 charged, 6,000 returned
pnpm gate:inference:setup && pnpm gate:inference   # metered, real model (523 MB)
```

Details: [docs/payments.md](docs/payments.md).

### 3. Run a seller and a buyer

Use a separate working directory per role. Seller:

```sh
export GYBLOS_RELAY_TOKEN=...   # 32-512 characters; never commit it
pnpm gate:setup --role seller --mint MINT --buyer BUYER_ADDRESS --pay-to PAYOUT_ADDRESS
pnpm gate:inference:setup       # downloads the pinned model
pnpm node:start                 # writes the signed offer to .local/p2p/offer.json
```

Buyer: same token, `pnpm gate:setup --role buyer --mint MINT`, put the seller's
`offer.json` and a `trust.json` in `.local/p2p/`, then `pnpm buyer:start`. Full
steps: [docs/running-a-node.md](docs/running-a-node.md).

## Commands

| Group  | Command                                              | What it does                                                    |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------- |
| Node   | `pnpm node:start`, `buyer:start`                     | Start the seller node; start the buyer proxy (`:4031`).         |
| Node   | `pnpm p2p:reconcile`                                 | Verify a P2P payment; clear a zero-charge block.                |
| Gate   | `pnpm gate:setup`                                    | Create devnet keys; `--role buyer\|seller` for P2P.             |
| Gate   | `pnpm gate:fund`                                     | Provision accounts; `--test-mint` makes a test token.           |
| Gate   | `pnpm gate:preflight`, `gate:challenge`              | Check devnet and balances; check that unpaid gets 402.          |
| Gate   | `pnpm gate:run`                                      | Run the fixed-resource `upto` payment end to end.               |
| Gate   | `pnpm gate:failures`                                 | Empty buyer and expired authorization (about 62 s).             |
| Gate   | `pnpm gate:facilitator`, `gate:seller`, `gate:buyer` | Run the fixed-resource roles separately (ports 4022, 4021).     |
| Gate   | `pnpm gate:exact`                                    | Fixed price through the public x402.org facilitator.            |
| Gate   | `pnpm gate:inference:setup`, `gate:inference`        | Download the model; run six metered cases.                      |
| Lab    | `pnpm identity:devnet-run`                           | Try the sponsored 8004 registration on devnet.                  |
| Checks | `pnpm test`, `test:lab`, `test:all`                  | Product tests (PR gate), lab tests, both.                       |
| Checks | `pnpm typecheck`                                     | TypeScript, including tests.                                    |
| Checks | `pnpm lint`                                          | ESLint, Prettier and import boundaries.                         |
| Checks | `pnpm boundaries`, `tooling:test`                    | Boundary check (`--json`); tests of the checker and lint rules. |
| Checks | `pnpm format`, `format:check`                        | Format and sort imports; check only.                            |

## Configuration

Set these in the environment; `.env` is **not** loaded
([.env.example](.env.example)).

| Variable                                        | Used by       | Meaning                                                   |
| ----------------------------------------------- | ------------- | --------------------------------------------------------- |
| `GYBLOS_RELAY_TOKEN`                            | seller, buyer | **Required.** Relay credential, 32-512 characters.        |
| `GYBLOS_RELAYS`                                 | seller, buyer | Comma-separated relay URLs; default `na1` only.           |
| `GYBLOS_RELAY_ONLY`                             | seller        | `1` = relay only; advertise no direct addresses.          |
| `GYBLOS_BUYER_RELAY_ONLY`                       | buyer         | `1` = loopback binds; dial the seller only via its relay. |
| `GYBLOS_IROH_BIND`, `GYBLOS_IROH_EXTERNAL_ADDR` | seller, buyer | UDP bind address; extra public address to advertise.      |
| `GYBLOS_EXPECTED_ROUTE`                         | buyer         | Require `iroh-direct` or `iroh-relay` before paying.      |
| `GYBLOS_RPC_URL`                                | all           | Devnet RPC; default `https://api.devnet.solana.com`.      |
| `GYBLOS_GATE_CONFIG`                            | gates         | Gate config file; default `.local/devnet/config.json`.    |
| `GYBLOS_IDENTITY_INTEGRATION`                   | lab tests     | `1` = run opt-in local-validator identity tests.          |

## Repository layout

```text
apps/node/              seller daemon (node:start)
apps/buyer/             buyer proxy, one paid call, and p2p:reconcile
apps/facilitator/       local x402 facilitator process
packages/protocol/      wire format: signed bytes, Engine contract, error codes (SPEC.md)
packages/core/          pricing, metering and offer trust rules
packages/config/        addresses, ports, paths, limits
packages/runtime/       files, processes, private logs, memory checks
packages/engine-ollama/ Ollama client and tokenizer
packages/payments-x402/ x402 payments, facilitator, chain proofs, recovery locks
packages/transport-iroh/ HTTP over Iroh, relays, admission limits
packages/identity/      8004 registry adapter (not wired yet)
packages/node/          seller composition; roles and offers shared with apps/buyer
lab/harness/            gate:* proof-of-concept checks, exact scheme, fixed-price test seller (Docker/NAT lab: tag archive/poc-lab-2026-10)
lab/tools/              identity devnet tools
lab/evidence/           three published, redacted run reports
tests/, tooling/        offline tests and fixtures; boundary checker and lint rules
```

## Safety

- A timeout is **not** a refund; uncertain payments block new ones until
  reconciled. Never delete `buyer.lock` or a journal to retry
  ([recovery](docs/recovery.md)).
- Use only generated devnet keys. Never commit keys, tokens, journals or logs.

## Documentation

[Architecture](docs/architecture.md) · [Running a node](docs/running-a-node.md)
· [Payments](docs/payments.md) · [Inference](docs/inference.md) ·
[Recovery](docs/recovery.md) · [Identity](docs/identity.md) ·
[Stack](docs/stack.md) · [Limitations](docs/limitations.md) ·
[Protocol spec](packages/protocol/SPEC.md) · [Tests](tests/README.md) ·
[Contributing](AGENTS.md)
