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

## Desktop preview

The Electron preview in `apps/desktop` targets macOS, Windows and Linux and
reuses the compact Chat and Connect mockup, with in-memory conversations and
simulated responses/connections. Normal startup prepares a protected local
wallet; portable backup is pending and funding remains disabled. Local packaging
is macOS arm64 only. A separate wallet-free smoke retains the isolated Iroh
loopback check. See [running and packaging the preview](docs/desktop-probe.md).

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
pnpm install --frozen-lockfile
pnpm check
```

No wallet, model or network needed; unsupported native cases skip explicitly.

### Local node and discovery acceptance (no payments)

```sh
pnpm --filter @gyblos/lab-harness acceptance:node-discovery # publication to signed quote
pnpm --filter @gyblos/lab-harness acceptance:free           # publication to complete answer
pnpm --filter @gyblos/lab-harness acceptance:free-stream    # early fragments and cancellation
pnpm acceptance:receipts                                  # product startup to confirmed receipts
```

Uses a synthetic engine, native loopback Iroh and an in-process memory index.
Temporary identities/state only; never contacts the deployed index or RPC.
[Coverage, evidence limits and explicit real-engine mode](docs/node-discovery-acceptance.md).

### 2. Lab: a devnet payment on one machine

The `gate:*` commands are lab proof-of-concept checks, not seller or buyer
setup.

```sh
pnpm gate:setup              # creates isolated keys in .local/lab/
# fund the printed facilitator address with at least 0.05 devnet SOL
pnpm gate:fund --test-mint   # creates the six-decimal test token
pnpm gate:preflight          # checks devnet, program, mint and funding
pnpm gate:challenge          # unpaid request must get HTTP 402
pnpm gate:run                # 10,000 deposited, 4,000 charged, 6,000 returned
pnpm gate:inference:setup && pnpm gate:inference   # metered, real model (523 MB)
```

Details: [docs/payments.md](docs/payments.md).

### 3. Run a seller and a buyer

Each role keeps its own directory under one local home (`.local/gyblos/`).
Seller:

```sh
export GYBLOS_RELAY_TOKEN=...   # 32-512 characters; never commit it
pnpm node:setup --role seller --mint MINT   # free selling needs no payout or buyer address
pnpm node:tokenizer             # pinned tokenizer, for offers whose usage the seller recounts
# run your own engine (a dedicated Ollama, or an OpenAI- or Anthropic-compatible API; see the full steps)
cp examples/seller-daemon.toml gyblos.toml   # one free offer; paid selling is off for now
pnpm gyblos doctor              # read-only preflight; prints the public NodeId and owner
pnpm node:start
```

Buyer: same token, `pnpm node:setup --role buyer --mint MINT`, then
`pnpm buyer:free` for the free chat endpoint (it also needs a `selection.json`;
see the full steps). The paid v1 buyer flow (`buyer:trust`, `buyer:start`) needs
a paid seller, which only the lab gates run until paid selling returns. Full
steps: [docs/running-a-node.md](docs/running-a-node.md).

## Commands

| Group  | Command                                              | What it does                                                                           |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Node   | `pnpm node:start`, `buyer:start`                     | Start the seller node; start the buyer proxy (`:4031`).                                |
| Node   | `pnpm gyblos config validate --config gyblos.toml`   | Check a node config file and the environment ([configuration](docs/configuration.md)). |
| Node   | `pnpm node:setup --role buyer\|seller --mint MINT`   | Create isolated role keys without RPC or funding.                                      |
| Node   | `pnpm node:tokenizer`                                | Download and verify the pinned tokenizer for either role, without an engine.           |
| Node   | `pnpm buyer:setup`                                   | The same tokenizer download, under the buyer's older name.                             |
| Node   | `pnpm buyer:free`                                    | Start the separate free v2 chat endpoint (complete or SSE) (`:4031`).                  |
| Node   | `pnpm buyer:trust`                                   | Verify the offer against explicit seller identities and create trust.                  |
| Node   | `pnpm buyer:call`, `buyer:reconcile`                 | One paid synthetic call; verify a payment, clear a zero-charge block.                  |
| Lab    | `pnpm gate:setup`                                    | Create isolated lab devnet keys.                                                       |
| Lab    | `pnpm gate:fund`                                     | Provision accounts; `--test-mint` makes a test token.                                  |
| Lab    | `pnpm gate:preflight`, `gate:challenge`              | Check devnet and balances; check that unpaid gets 402.                                 |
| Lab    | `pnpm gate:run`                                      | Run the fixed-resource `upto` payment end to end.                                      |
| Lab    | `pnpm gate:failures`                                 | Empty buyer and expired authorization (about 62 s).                                    |
| Lab    | `pnpm gate:facilitator`, `gate:seller`, `gate:buyer` | Run the fixed-resource roles separately (ports 4022, 4021).                            |
| Lab    | `pnpm gate:exact`                                    | Fixed price through the public x402.org facilitator.                                   |
| Lab    | `pnpm gate:inference:setup`, `gate:inference`        | Download the model; run six metered cases.                                             |
| Lab    | `pnpm identity:devnet-run`                           | Try the sponsored 8004 registration on devnet.                                         |
| Lab    | `pnpm identity:fixtures`                             | Recapture the public registry fixture (read-only devnet).                              |
| Checks | `pnpm test`, `test:lab`, `test:all`                  | Product tests (PR gate), lab tests, both.                                              |
| Checks | `pnpm typecheck`                                     | TypeScript, including tests.                                                           |
| Checks | `pnpm check`                                         | Typecheck, lint (including tooling), product and lab tests.                            |
| Checks | `pnpm lint`                                          | ESLint, Prettier, tooling tests and import boundaries.                                 |
| Checks | `pnpm boundaries`, `tooling:test`                    | Boundary check (`--json`); tests of the checker and lint rules.                        |
| Checks | `pnpm format`, `format:check`                        | Format and sort imports; check only.                                                   |

## Configuration

Set these in the environment; `.env` is **not** loaded
([.env.example](.env.example)).

| Variable                                        | Used by       | Meaning                                                    |
| ----------------------------------------------- | ------------- | ---------------------------------------------------------- |
| `GYBLOS_RELAY_TOKEN`                            | seller, buyer | **Required.** Relay credential, 32-512 characters.         |
| `GYBLOS_RELAYS`                                 | seller, buyer | Comma-separated relay URLs; default `na1` only.            |
| `GYBLOS_RELAY_ONLY`                             | seller        | `1` = relay only; advertise no direct addresses.           |
| `GYBLOS_BUYER_RELAY_ONLY`                       | buyer         | `1` = loopback binds; dial the seller only via its relay.  |
| `GYBLOS_IROH_BIND`, `GYBLOS_IROH_EXTERNAL_ADDR` | seller, buyer | UDP bind address; extra public address to advertise.       |
| `GYBLOS_EXPECTED_ROUTE`                         | buyer         | Require `iroh-direct` or `iroh-relay` before paying.       |
| `GYBLOS_RPC_URL`                                | all           | Devnet RPC; default `https://api.devnet.solana.com`.       |
| `GYBLOS_HOME`                                   | all           | Local home; default `.local/gyblos`. Lab: artifacts/ only. |
| `GYBLOS_LAB_HOME`                               | lab           | Lab home; default `.local/lab`.                            |
| `GYBLOS_GATE_CONFIG`                            | lab           | Lab config file; default `.local/lab/config.json`.         |
| `GYBLOS_P2P_RUN_ID`                             | seller, buyer | Optional label copied into `status.json` and evidence.     |
| `GYBLOS_GATE_RUN_ID`                            | lab           | Run label set by `gate:run`/`gate:inference` for children. |
| `GYBLOS_IDENTITY_INTEGRATION`                   | lab tests     | `1` = run opt-in local-validator identity tests.           |

Keep a custom `GYBLOS_HOME` or `GYBLOS_LAB_HOME` outside the repository or under
`.local/`, the only ignored local path.

## Repository layout

`apps/` holds the product executables (seller node, buyer, desktop host and the
discovery index Worker), `packages/` the libraries they share, `lab/` the gate
checks, the standalone lab facilitator and their evidence, and `tests/` and
`tooling/` the offline checks. Package-by-package map:
[docs/architecture.md](docs/architecture.md).

## Safety

- A timeout is **not** a refund; uncertain payments block new ones until
  reconciled. Never delete `buyer.lock` or a journal to retry
  ([recovery](docs/recovery.md)).
- Use only generated devnet keys. Never commit keys, tokens, journals or logs.

## Documentation

[Architecture](docs/architecture.md) · [Running a node](docs/running-a-node.md)
· [Configuration](docs/configuration.md) · [Payments](docs/payments.md) ·
[Inference](docs/inference.md) · [Recovery](docs/recovery.md) ·
[Identity](docs/identity.md) · [Discovery](docs/discovery.md) ·
[Discovery index](docs/discovery-index.md) · [Stack](docs/stack.md) ·
[Limitations](docs/limitations.md) · [Protocol spec](packages/protocol/SPEC.md)
· [Tests](tests/README.md) · [Code standards](docs/code-standards.md) ·
[Contributing](AGENTS.md)

## Telemetry adapters

The optional [aggregate OpenTelemetry adapter](docs/telemetry-otel.md) exports
metrics only when explicitly constructed and flushed by a caller. It is not
wired into node startup. Local record adapters remain separate.

The free seller and buyer APIs support explicitly supplied local event sinks;
see [local telemetry composition and event semantics](docs/local-telemetry.md).
CLI startup remains opt-in through a future configuration integration.
