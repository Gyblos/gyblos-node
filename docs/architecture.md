# Architecture

A pnpm workspace of small TypeScript packages, four apps (seller node, buyer,
the provisional Electron desktop host and the discovery index Worker) and a lab.
The wire format is specified in
[packages/protocol/SPEC.md](../packages/protocol/SPEC.md). Technology choices
are in [stack.md](stack.md).

## Packages

| Package                      | Layer      | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`          | protocol   | Canonical JSON, signing domains and bytes, Iroh ALPNs, `Engine` contract, payment ports (`payment.ts`: `PaymentClient`, `PaymentServer`, `PaymentError`; no adapter yet), error codes, model catalog; v1 signed offers and public records, v2 public records (`public-v2`), quotes (`offer-v2`) and `control-*` contracts, golden vectors. No SDKs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/core`              | core       | Pricing and metering math, offer trust rules (`offers`), charge-anomaly checks, control admission leases (`control-admission`), control quote policy (`control-quotes`), free admission (`free-admission`: a seller-wide ledger for single use, concurrency and daily buyers, and per-offer token budgets), buyer seller selection (`seller-selection*`), the failure precedence, bounded HTTP/SSE readers and provider API helpers every engine adapter shares (`engine-failures`, `engine-http`, `engine-provider`). No SDKs or filesystem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/config`            | config     | Devnet addresses, ports, operator limits, relay and discovery index defaults, `GYBLOS_*` environment variable names (`NODE_ENVIRONMENT` in `environment.ts`) and the local home layout (`home.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/runtime`           | runtime    | Atomic JSON writes, private rotating logs, processes, memory probes, loopback `Host` guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/engine-ollama`     | adapter    | Ollama client, `Engine` adapter, pinned tokenizer and model constants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/engine-openai`     | adapter    | OpenAI-compatible chat completions client as an `Engine` (streamed, provider usage, name-only identity, API key only to its base URL).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/engine-anthropic`  | adapter    | Anthropic Messages API client as an `Engine` (streamed, provider usage with cached input, thinking never delivered, name-only identity, API key only to its root URL).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/payments-x402`     | adapter    | x402 `upto`, facilitator, buyer signer, on-chain proofs, recovery locks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/x402-upto-metered` | standalone | Metered x402 `upto` payments over any transport (provisional name, Apache-2.0). Imports no workspace package; only `payments-*` adapters import it. Error codes only so far.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/transport-iroh`    | adapter    | Iroh endpoint, HTTP over QUIC and its wire framing limits, relay policy, admission, control client/server and frame I/O (`control-*`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/identity`          | adapter    | 8004 registry adapter; not used by the node yet ([identity.md](identity.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/discovery-http`    | adapter    | HTTP discovery index client; untrusted records re-verified; optional buyer integration with independent trust and persistent replay state ([discovery.md](discovery.md)). The reference index itself is `apps/discovery-index`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/telemetry-file`    | adapter    | Lazy content-free telemetry through the private rotating runtime log; file-only opt-in composition at seller/free-buyer startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/telemetry-otel`    | adapter    | Optional bounded aggregate metrics through an injected OpenTelemetry exporter; explicit lifecycle, no node wiring ([contract](telemetry-otel.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/telemetry-console` | adapter    | Content-free telemetry through an injected write callback; no global console dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/node`              | node       | Local-node library for both roles: seller composition (`createNode`, the warmed offers and which of them the catalog lists in `seller-offer-set`, startup and background warmups in `seller-offers`, the free channels routed per offer by `free-router` over per-offer services in `free-offers`, each counting tokens recounted or provider-declared through `free-meter` and the control service, cached readiness lifecycle in `control-*`, private engine checks in `engine-readiness`, engine plugins by kind in `engine-registry` (`engine-registry-ollama`, `engine-registry-openai`, `engine-registry-anthropic`, provider URL rules in `engine-urls`) with the `engine-factory` contract, so control startup, readiness, seller startup and doctor's engine check name no plugin; the seller runs its own engine and the daemon never starts one), roles and keys, signed offers, tokenizer artifacts and inference pricing used by `apps/buyer`, and the `gyblos.toml` validator and precedence resolver (`node-config*`, schema in `schemas/`). |

| App                    | Command                                       | Responsibility                                                                                                                                                      |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/node`            | `node:start` (`main.ts`), `gyblos` (`cli.ts`) | Seller daemon; starts `createNode`, which serves the free offer. `gyblos config validate` checks `gyblos.toml` ([configuration.md](configuration.md)).              |
| `apps/buyer`           | `buyer:start`, `buyer:reconcile`              | Buyer proxy, one paid call (`call.ts`), measurements, recovery, one-seller control client, opt-in seller selection and offer race (`selection-*`, `offer-race.ts`). |
| `apps/desktop`         | `desktop:start`, `desktop:smoke`              | Electron desktop host (provisional): simulated Chat/Connect preview and loopback Iroh probe ([desktop-probe.md](desktop-probe.md)).                                 |
| `apps/discovery-index` | none (Cloudflare Worker, manual deploy)       | Reference HTTP discovery index for `discovery.gyblos.com` (Hono, D1); verifies records only through protocol ([discovery-index.md](discovery-index.md)).            |

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
- Adapters are plugins: packages named by family (`engine-*`, `payments-*`,
  `transport-*`, `discovery-*`, `telemetry-*`, plus `identity`), each
  implementing a port, chosen by composition in `packages/node`. They do not
  import each other. Inference knows no wallets; payment code knows no engines.
- Apps do not import other apps.
- Product code (`packages/`, `apps/`) never imports `lab/`, `tests/` or
  `tooling/`.
- Other workspaces are imported by package name and only through their
  `exports`; files inside one package use relative imports.

## Seller selection

`@gyblos/core/seller-selection` owns the buyer router's choice of sellers
(`selectSellers`). It is a pure function: the caller passes v2 catalogs,
presence and withdrawals, a checkability badge per seller (the catalog carries
none), local per-seller stats, `now`, a random source and optionally its own
policy (default `SELLER_SELECTION_POLICY`; a gateway may inject its own). Before
calling, the caller verifies each catalog with `verifyPublicV2` and each
presence and withdrawal with `verifyPublicV2` against that exact catalog, which
binds their `catalogDigest`; selection compares only owner, NodeId, sequence and
lifetimes, and any later withdrawal excludes the seller.

It applies hard filters (exact model, reasoning level, badge, data policy, price
ceilings, budget, fresh presence, cooldown), then draws a few candidates by
weighted sampling: cheaper is likelier but not certain, a free offer weighs
twice the cheapest paid one, an open channel looks cheaper, and local reputation
(success rate, with latency and wait accuracy shrunk toward neutral while
samples are few) scales the weight within bounds, so repeated failures outweigh
a low price. Each owner contributes at most one NodeId. One slot goes to a
seller with no local history; once the buyer knows enough sellers, such
newcomers compete only for that slot. A competitive previous seller keeps the
first slot. Lower reasoning levels of the same model are used only when the
buyer allows them, closest first down to the buyer's floor, after every
exact-level candidate; the offer race must never accept a downgrade offer while
an exact candidate's offer is pending or available. A pinned seller skips
sampling, never the filters; a pinned seller in cooldown is refused with its
cooldown end. Asking candidates for live offers, persisting stats and wiring
into the buyer app are separate work.

## Boundary checker

`pnpm boundaries` (also part of `pnpm lint`) checks these rules statically with
dependency-cruiser. It parses source without running it, skips private and
generated paths and fails on any violation or analysis error. `--json` prints a
structured report; `pnpm tooling:test` tests the checker and the lint rules.

## Runtime picture

```text
buyer machine                               seller machine
apps/buyer proxy :4031 ── Iroh ──────────▶  packages/node seller
  (transport-iroh client)  direct or relay    ├─ control + free channels (Iroh ALPNs)
                                              └─ seller's own Ollama, loopback URL from gyblos.toml (engine-ollama)
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
  seller/    role.json, node.key, owner key (setup also writes authorizer and
             facilitator keys, unused while paid selling is off), status,
             readiness, public sequence
  artifacts/ tokenizer/ (public, hash-pinned, shared), ollama-models/ (lab cache)
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

### Identity reading policy

`@gyblos/identity/resolution` owns pinned, bounded read-only 8004 account
resolution. Its `resolution-rpc` entry owns the default buyer's
decoded-byte-limited read-only HTTP transport; SDK parsing occurs only after the
response limit. `@gyblos/core/identity-policy` owns manual precedence and scoped
binding high-water/tombstone decisions without SDKs or I/O. Callers must retain
returned state even on denial. Node `identity-state*` owns durable scoped buyer
metadata; `identity-verifier` composes independent registry reads with it.
Opt-in buyer selection/discovery admission uses these APIs while explicit manual
trust remains available. See
[identity](identity.md#read-only-resolution-and-trust-policy).

### Free receipt composition

`@gyblos/node/receipts` owns local receipt orchestration and bounded
persistence. Its store validates signed snapshots and role identity; filesystem
checks and atomic replacement live separately from the pure snapshot schema.
Seller observations go through an injected publisher; buyer observations cross
into node composition as metadata only. The Iroh adapter remains
storage-agnostic. The protocol owns wire records, the core owns receipt policy
and the node owns signers, lifecycle and private files. Neither receipt failures
nor metadata RPCs enter inference failover. No collector or payment service is
involved.
