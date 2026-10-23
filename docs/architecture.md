# Architecture

A pnpm workspace of small TypeScript packages, three apps and a lab. The wire
format is specified in
[packages/protocol/SPEC.md](../packages/protocol/SPEC.md). Technology choices
are in [stack.md](stack.md).

## Packages

| Package                   | Layer    | Responsibility                                                                                                        |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`       | protocol | Canonical JSON, signed offer bytes, `Engine` contract, error codes, model catalog, public discovery records. No SDKs. |
| `packages/core`           | core     | Pricing and metering math, offer trust rules, charge-anomaly checks. No SDKs or filesystem.                           |
| `packages/config`         | config   | Devnet addresses, ports, paths, limits, relay defaults, wallet loading.                                               |
| `packages/runtime`        | runtime  | Atomic JSON writes, private rotating logs, processes, memory probes, loopback `Host` guard.                           |
| `packages/engine-ollama`  | adapter  | Ollama client, `Engine` adapter, pinned tokenizer and model constants.                                                |
| `packages/payments-x402`  | adapter  | x402 `upto`, facilitator, buyer signer, on-chain proofs, recovery locks.                                              |
| `packages/transport-iroh` | adapter  | Iroh endpoint, HTTP over QUIC, relay policy, admission limits.                                                        |
| `packages/identity`       | adapter  | 8004 registry adapter; not used by the node yet ([identity.md](identity.md)).                                         |
| `packages/node`           | node     | Seller composition (`createNode`), roles and keys, signed offers, measurements.                                       |

| App                | Command                        | Responsibility                                    |
| ------------------ | ------------------------------ | ------------------------------------------------- |
| `apps/node`        | `node:start` (`main.ts`)       | Seller daemon.                                    |
| `apps/buyer`       | `buyer:start`, `p2p:reconcile` | Buyer proxy, one paid call (`call.ts`), recovery. |
| `apps/facilitator` | `gate:facilitator`             | Standalone local facilitator.                     |

`lab/harness` holds the `gate:*` proof-of-concept checks (including the x402
`exact` scheme, the fixed-price test seller and the gate runner), `lab/tools`
the identity devnet tools and `lab/evidence` the published reports. `tests/` and
`tooling/` verify everything and may import any layer.

## Dependency rule

```text
protocol ◀── core ◀── adapters ◀── node ◀── apps
   ▲ config and runtime are shared support above protocol
```

- Protocol imports nothing else and no SDK.
- Core imports only protocol (and config/runtime); no SDKs, no filesystem.
- Adapters do not import each other. Inference knows no wallets; payment code
  knows no engines.
- Apps do not import other apps.
- Product code (`packages/`, `apps/`) never imports `lab/`, `tests/` or
  `tooling/`.
- Other workspaces are imported by package name and only through their
  `exports`; files inside one package use relative imports.

## Boundary checker

`pnpm boundaries` (also part of `pnpm lint`) checks these rules statically with
dependency-cruiser. It parses source without running it, skips private and
generated paths and fails on any violation, analysis error or nonempty baseline.
`tooling/boundaries-baseline.json` must stay `[]`; `--update-baseline` can only
confirm an empty one. `--json` prints a structured report;
`pnpm boundaries:test` tests the checker itself.

## Runtime picture

```text
buyer machine                               seller machine
apps/buyer proxy :4031 ── Iroh ──────────▶  packages/node seller
  (transport-iroh client)  direct or relay    ├─ HTTP :4032 /v1/chat/completions
  payments-x402 signer                        ├─ facilitator :4022 (payments-x402)
                                              └─ Ollama :11436 (engine-ollama)
```

Everything except the Iroh endpoint listens on loopback only. See
[running-a-node.md](running-a-node.md).
