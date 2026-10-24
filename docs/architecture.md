# Architecture

A pnpm workspace of small TypeScript packages, two product apps, a local desktop
compatibility probe and a lab. The wire format is specified in
[packages/protocol/SPEC.md](../packages/protocol/SPEC.md). Technology choices
are in [stack.md](stack.md).

## Packages

| Package                   | Layer    | Responsibility                                                                                                                                                       |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`       | protocol | Canonical JSON, signed offer wire shape, domain and bytes, Iroh ALPN, `Engine` contract, error codes, model catalog, public discovery records. No SDKs.              |
| `packages/core`           | core     | Pricing and metering math, offer trust rules, charge-anomaly checks, buyer seller selection. No SDKs or filesystem.                                                  |
| `packages/config`         | config   | Devnet addresses, ports, operator limits, relay defaults and the local home layout (`home.ts`).                                                                      |
| `packages/runtime`        | runtime  | Atomic JSON writes, private rotating logs, processes, memory probes, loopback `Host` guard.                                                                          |
| `packages/engine-ollama`  | adapter  | Ollama client, `Engine` adapter, pinned tokenizer and model constants.                                                                                               |
| `packages/payments-x402`  | adapter  | x402 `upto`, facilitator, buyer signer, on-chain proofs, recovery locks.                                                                                             |
| `packages/transport-iroh` | adapter  | Iroh endpoint, HTTP over QUIC and its wire framing limits, relay policy, admission.                                                                                  |
| `packages/identity`       | adapter  | 8004 registry adapter; not used by the node yet ([identity.md](identity.md)).                                                                                        |
| `packages/node`           | node     | Local-node library for both roles: seller composition (`createNode`), roles and keys, signed offers, tokenizer artifacts and inference pricing used by `apps/buyer`. |

| App          | Command                          | Responsibility                                                  |
| ------------ | -------------------------------- | --------------------------------------------------------------- |
| `apps/node`  | `node:start` (`main.ts`)         | Seller daemon with its embedded facilitator.                    |
| `apps/buyer` | `buyer:start`, `buyer:reconcile` | Buyer proxy, one paid call (`call.ts`), measurements, recovery. |

"Gate" is a lab word only. `lab/harness` holds the `gate:*` proof-of-concept
checks (including the x402 `exact` scheme, the fixed-price test seller, the gate
runner and the devnet wallet configuration), `lab/facilitator` the standalone
local facilitator (`gate:facilitator`), `lab/tools` the identity devnet tools
and `lab/evidence` the published reports. `lab/harness`, `lab/facilitator` and
`lab/tools` are runnable through the package scripts; `lab/evidence` is a
historical record of past runs, and the archived Docker/NAT lab lives only at
tag `archive/poc-lab-2026-10`. `tests/` and `tooling/` verify everything and may
import any layer.

The experimental `apps/desktop` hosts a simulated Chat/Connect renderer plus a
separate sandboxed compatibility view and a loopback-only Iroh utility probe,
reusing the node lifecycle. It does not start the buyer or seller app; see
[desktop-probe.md](desktop-probe.md).

## Where `@gyblos/*` comes from

These are private local packages in this repository. `@gyblos` is their shared
namespace. `pnpm-workspace.yaml` registers `packages/*`, `apps/*`, `lab/harness`
and `lab/facilitator`; each package declares its own name in `package.json`.
Dependencies such as `"@gyblos/protocol": "workspace:*"` tell pnpm to link the
local package during installation.

For example, `@gyblos/protocol/errors` resolves through the `./errors` export in
`packages/protocol/package.json` to `packages/protocol/src/errors.ts`. There is
no TypeScript path alias or generated package behind that import. P2P role keys
are loaded by `packages/node/src/roles.ts`; `@gyblos/lab-harness/wallet` loads
the lab devnet wallet configuration.

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

## Seller selection

`@gyblos/core/seller-selection` owns the buyer router's choice of sellers
(`selectSellers`). It is a pure function: the caller passes already verified v2
catalogs, presence and withdrawals, a checkability badge per seller, local
per-seller stats, `now` and a random source. It applies hard filters (exact
model, reasoning level, badge, data policy, price ceilings, budget, fresh
presence, cooldown), then draws a few candidates by weighted sampling: cheaper
is likelier but not certain, local reputation and an open channel shift the odds
within bounds, and one slot goes to a seller with no local history. A lower
reasoning level of the same model is used only when the buyer allows it, ranked
after every exact-level candidate. A pinned seller skips sampling, never the
filters. Asking candidates for live offers, persisting stats and wiring into the
buyer app are separate work.

## Boundary checker

`pnpm boundaries` (also part of `pnpm lint`) checks these rules statically with
dependency-cruiser. It parses source without running it, skips private and
generated paths and fails on any violation or analysis error. `--json` prints a
structured report; `pnpm tooling:test` tests the checker and the lint rules.

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

## Local data

One module, `packages/config/src/home.ts`, owns every local path as a pure
function of the environment; no other module builds `.local/...` paths.

```text
$GYBLOS_HOME (default .local/gyblos; a container would use /data)
  buyer/     role.json, node.key, buyer.json, trust.json, offer.json, journals,
             locks, calls, status, transport metrics, measurements + salt
  seller/    role.json, node.key, owner/authorizer/facilitator keys, offer.json,
             status, traces, readiness, facilitator-diagnostics/
  artifacts/ tokenizer/, ollama-models/   (public, hash-pinned, shared)
$GYBLOS_LAB_HOME (default .local/lab)
  lab config, keys, journals, measurements, facilitator-diagnostics/, identity/
```

Payment adapters receive journal and lock paths from the apps, which take them
from this layout. The lab shares `artifacts/` as a public cache (its setup may
write the tokenizer and model there) and never reads or writes a role directory.
`packages/node/src/home.ts` refuses to start with a missing home directory (for
the lab: a lab home without lab state) when its legacy path exists; see
[running-a-node.md](running-a-node.md#local-home).

Named values follow their readers: HTTP-over-Iroh framing limits and stream
deadlines are `transport-iroh` constants, the offer lifetime is a `core` trust
rule, call and proof bounds belong to the buyer app, and only operator-tunable
capacity, rate, timeout and port values stay in `config` (`TRANSPORT_LIMITS`,
`TRANSPORT_TIMEOUTS`, `PORTS`).
