# Architecture

Gyblos Node is a pnpm workspace of small TypeScript packages, eight apps and a
lab. This page explains how they fit together: which package owns what, the
dependency rule, how a request flows between a buyer and a seller, and where
local data lives.

- The wire format is specified in
  [packages/protocol/SPEC.md](../packages/protocol/SPEC.md).
- Technology choices are in [stack.md](stack.md).
- The repository rules (layers, imports, standalone packages) are in
  [AGENTS.md](../AGENTS.md#layers-and-ownership). Where a new module goes is in
  the [gyblos-code-map skill](../.agents/skills/gyblos-code-map/SKILL.md).

## Packages

`pnpm-workspace.yaml` registers `packages/*`, `apps/*` and `lab/harness`. The
layer of each package comes from `tooling/boundaries/config.ts`.

| Package                      | Layer      | Responsibility                                                                                                                                                                                                 |
| ---------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`          | protocol   | Wire contracts: canonical JSON, signing domains, Iroh ALPNs, error codes, the model catalog, golden vectors. Ports: `Engine`, `PaymentClient`, `PaymentServer`, `ExecutionPolicy`, telemetry. No SDKs.         |
| `packages/core`              | core       | Pure policy: pricing and metering, offer trust (`offers`), free admission, control admission and quotes, seller selection (`seller-selection*`), public receipt policy, shared engine HTTP helpers. No SDKs.   |
| `packages/config`            | config     | Operator values: devnet addresses, ports, limits, relay, discovery index and collector URLs, `GYBLOS_*` variable names, and the local home layout (`home.ts`).                                                 |
| `packages/runtime`           | runtime    | Platform helpers: atomic JSON writes, private rotating logs, processes, memory probes, the loopback `Host` guard, the diagnostic envelope.                                                                     |
| `packages/inference`         | inference  | The SDK-free execution lifecycle and conversation pipeline over protocol ports. Node supplies engines, economic policy and observation.                                                                        |
| `packages/engine-ollama`     | adapter    | Ollama client as an `Engine`, with the pinned tokenizer and model constants.                                                                                                                                   |
| `packages/engine-openai`     | adapter    | OpenAI-compatible chat completions client as an `Engine` (also LM Studio and other compatible servers).                                                                                                        |
| `packages/engine-anthropic`  | adapter    | Anthropic Messages API client as an `Engine`.                                                                                                                                                                  |
| `packages/payments-upto`     | adapter    | `PaymentServer` over `x402-upto-metered`: maps Gyblos terms to upto terms, admits only this seller's terms, keeps the durable seller ledger and the reusable payment session. See [payments.md](payments.md).  |
| `packages/payments-paypal`   | adapter    | Direct-merchant PayPal Sandbox authorization and capture for a local prototype. No live PayPal ([paypal-sandbox.md](paypal-sandbox.md)).                                                                       |
| `packages/x402-upto-metered` | standalone | Metered x402 `upto` payments over any transport (Apache-2.0). Imports no workspace package; only `payments-*` adapters import it.                                                                              |
| `packages/transport-iroh`    | adapter    | Iroh endpoint, HTTP over QUIC and its framing limits, relay policy, admission, and the client and server side of every channel.                                                                                |
| `packages/identity`          | adapter    | Bounded read-only resolution in the 8004 agent registry ([identity.md](identity.md)).                                                                                                                          |
| `packages/discovery-http`    | adapter    | Discovery index client; re-verifies every untrusted record ([discovery.md](discovery.md)).                                                                                                                     |
| `packages/telemetry-file`    | adapter    | Content-free telemetry to the private rotating log ([telemetry.md](telemetry.md)).                                                                                                                             |
| `packages/telemetry-otel`    | adapter    | Bounded aggregate metrics through an injected OpenTelemetry exporter. Not composed by the node ([telemetry.md](telemetry.md#opentelemetry-adapter)).                                                           |
| `packages/telemetry-console` | adapter    | Content-free telemetry through an injected write callback.                                                                                                                                                     |
| `packages/node`              | node       | The local-node library for both roles. It composes adapters into the seller (offers, free and paid channels, sessions, control, receipts, registration) and the buyer runtime, and owns `config.toml` parsing. |

The local `@x402/svm` patch that `x402-upto-metered` relies on is described next
to its entry in `pnpm-workspace.yaml`.

## Apps

Apps are independent executables. They never import each other.

| App                      | Run with                                           | Responsibility                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/node`              | `pnpm gyblos <command>`, `pnpm node:start`         | The seller daemon and the `gyblos` CLI (`start`, `doctor`, `logs`, `config validate`, `seller init/status/register/service`). Installs a systemd, launchd or Windows service.                    |
| `apps/buyer`             | `pnpm buyer`, `pnpm buyer:chat`, `pnpm buyer:init` | The local buyer and its buyer endpoint: seller selection, offer race, free and paid calls, payment sessions, reconciliation and withdrawal ([buyer-init.md](buyer-init.md)).                     |
| `apps/desktop`           | `pnpm desktop:start`, `pnpm desktop:package`       | The desktop app (Electron): Chat, wallet, buyer API keys, activity and payments over a separately bundled local buyer ([desktop.md](desktop.md)).                                                |
| `apps/discovery-index`   | Cloudflare Worker                                  | The discovery index at `discovery.gyblos.com` (Hono, D1). Verifies records only through protocol ([discovery-index.md](discovery-index.md)).                                                     |
| `apps/metrics-collector` | Cloudflare Worker                                  | The metrics collector at `collector.gyblos.com` (Hono, D1): receives signed receipts and observations, builds aggregates and serves public stats ([metrics-collector.md](metrics-collector.md)). |
| `apps/receipt-collector` | `pnpm --filter @gyblos/receipt-collector start`    | The local receipt receiver: a private loopback receiver for testing, with bounded retention ([receipts.md](receipts.md)).                                                                        |
| `apps/docs`              | `pnpm docs:dev`, `pnpm docs:build`                 | The public docs site at `docs.gyblos.com`: a Fumadocs static export in English and Spanish ([README](../apps/docs/README.md)).                                                                   |
| `apps/explorer`          | `pnpm explorer:dev`                                | The public metrics explorer: a server-rendered Next.js app that reads the discovery index, the metrics collector's stats API and Solana. Not deployed.                                           |

Deploying a Worker or publishing a site is a maintainer action; see
[public-decisions.md](public-decisions.md).

## Other top-level directories

| Path                                    | What it holds                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `lab/`                                  | Validation outside the product: `harness`, `tools` and the historical `evidence` ([lab/README.md](../lab/README.md)).                        |
| `tests/`                                | Product and lab test suites ([tests/README.md](../tests/README.md)). Standalone packages keep theirs in `packages/<name>/test/`.             |
| `tooling/`                              | The boundary checker, lint rules, skills tooling, native and npm builds, and the [AI security review](../tooling/security-review/README.md). |
| `examples/`                             | Sample seller `config.toml` files ([configuration.md](configuration.md)).                                                                    |
| `Dockerfile`, `docker/`, `compose.yaml` | The Docker seller image and its entrypoint ([running-a-node.md](running-a-node.md#docker)).                                                  |
| `install.sh`, `install.ps1`             | The seller install scripts ([running-a-node.md](running-a-node.md#install-script)).                                                          |
| `scripts/`                              | Release and installer publishing scripts, run by maintainers.                                                                                |
| `patches/`                              | Dependency patches, each justified in `pnpm-workspace.yaml`.                                                                                 |

`tests/` and `tooling/` may import any layer. Product code never imports `lab/`,
`tests/` or `tooling/`. "Gate" is a lab word only.

## Dependency rule

```text
protocol ◀── core ◀── inference / adapters ◀── node ◀── apps
   ▲ config and runtime are shared support above protocol
```

The full rule set is in [AGENTS.md](../AGENTS.md#layers-and-ownership).
`pnpm boundaries` (part of `pnpm lint`) enforces it statically with
dependency-cruiser: it parses source without running it, skips private and
generated paths, and fails on any violation or analysis error. `--json` prints a
structured report; `pnpm tooling:test` tests the checker and the lint rules.

### Where `@gyblos/*` comes from

Every `@gyblos/*` package is a private package in this repository. A dependency
such as `"@gyblos/protocol": "workspace:*"` tells pnpm to link the local
package. An import like `@gyblos/protocol/errors` resolves through the
`./errors` entry in `packages/protocol/package.json` to
`packages/protocol/src/errors.ts`. There is no TypeScript path alias or
generated code behind it.

## Runtime picture

```text
buyer machine                                  seller machine
apps/buyer (buyer endpoint, loopback) ── Iroh ──▶ apps/node → packages/node seller
  or apps/desktop (bundled local buyer)  direct     ├─ control, free, paid and session channels (Iroh ALPNs)
                                         or relay   └─ the seller's own engine: Ollama, an OpenAI-compatible
                                                       server or the Anthropic API (from config.toml)

                both sides ──HTTPS──▶ discovery.gyblos.com (signed public records)
                both sides ──HTTPS──▶ collector.gyblos.com (signed receipts and observations, release builds)
```

Everything except the Iroh endpoint listens on loopback only. The seller runs
its engine itself; the daemon never starts one. See
[running-a-node.md](running-a-node.md).

A request flows like this:

1. The buyer finds sellers in the discovery index and verifies every record
   ([discovery.md](discovery.md)).
2. It asks candidates for signed quotes over the control channel and picks one
   ([Seller selection](#seller-selection)). A zero-price quote takes the free
   channel; a paid quote takes the paid channel or a reusable payment session.
3. The seller admits the request, generates within the permit and measures what
   it delivered ([Seller execution policies](#seller-execution-policies)).
4. The buyer recounts the result before it approves any charge.
5. Both sides write signed receipts locally; release builds upload them to the
   metrics collector ([receipts.md](receipts.md)).

## Seller execution policies

The free and paid channel adapters keep their own parsers, peer checks, signing
domains, response shapes and error codes. Both run through the SDK-free
`ExecutionPolicy` port and the lifecycle in `inference/src/execution.ts`: admit,
generate within the permit, measure delivered output, finish once and release
the generation slot.

- `policy-free.ts` applies replay protection, concurrency and token caps.
- Reusable payment sessions apply their own policy around the same lifecycle
  ([below](#reusable-payment-session-composition)).

Releasing capacity never clears a financial obligation, and cancelling a prompt
does not cancel financial completion.

Every policy emits through the same optional `TelemetrySink`. A `CHARGED`
observation uses a confirmed settlement's amounts, never a pending claim. A
later background retry or restart recovery does not add a request-path event, so
observations are not a financial ledger. No content or authorization payload
reaches telemetry ([telemetry.md](telemetry.md)).

## Seller selection

`@gyblos/core/seller-selection` owns the buyer's choice of sellers
(`selectSellers`). It is a pure function. The caller passes v2 catalogs,
presence and withdrawals, a checkability badge per seller, local per-seller
stats, `now`, a random source and optionally its own policy (default
`SELLER_SELECTION_POLICY`). Before calling, the caller verifies each catalog
with `verifyPublicV2`, and each presence and withdrawal against that exact
catalog, which binds their `catalogDigest`. Selection compares only owner,
NodeId, sequence and lifetimes; any later withdrawal excludes the seller.

Selection applies hard filters (exact model, reasoning level, badge, data
policy, ceilings, budget, fresh presence, cooldown), then draws a few candidates
by weighted sampling:

- Cheaper is likelier but not certain. A free offer weighs twice the cheapest
  paid one, and an open payment channel looks cheaper.
- Local reputation (success rate, with latency and wait accuracy shrunk toward
  neutral while samples are few) scales the weight within bounds, so repeated
  failures outweigh a low price.
- Each owner contributes at most one NodeId. One slot goes to a seller with no
  local history; a competitive previous seller keeps the first slot.
- Lower reasoning levels of the same model are used only when the buyer allows
  them, closest first, after every exact-level candidate. The offer race never
  accepts a downgrade while an exact candidate's offer is pending or available.
- A pinned seller skips sampling, never the filters. A pinned seller in cooldown
  is refused with its cooldown end.

The buyer app composes it: `apps/buyer/src/selection*.ts` builds the inputs and
persists stats, and `offer-race.ts` asks the candidates for live offers. The
operator view is in [payment-sessions.md](payment-sessions.md#buyer-routing).

## Reusable payment session composition

A reusable payment session is one capped, buyer-authorized deposit that pays for
many requests through post-usage cumulative signatures, with autonomous seller
finalization. The seller composes it at startup when paid selling is configured
(`packages/node/src/seller.ts`); the buyer app activates its session manager
from explicit buyer policy (`apps/buyer/src/session-startup.ts`).

| Concern                        | Owner                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| Payment port                   | `@gyblos/protocol/payment-session`                                     |
| Channel wire, parsing, digests | `@gyblos/protocol` batch channel and session blocks                    |
| Iroh I/O and admission         | `transport-iroh` batch client and server                               |
| Financial session              | `@gyblos/payments-upto/batch-session`                                  |
| Composition and recounting     | `@gyblos/node/batch-session`, `batch-buyer`, `batch-seller`            |
| Execution and conversation     | `packages/inference` (engine, metering and observation ports injected) |

Trusted hosts keep identity, signed quote and input verification, transport
authentication and the unresolved-payment barrier. The buyer independently
recounts tool-aware results before approving accumulated usage. Lifecycle,
private persistence, defaults and failure exposure are in
[payment-sessions.md](payment-sessions.md).

## Receipts and identity

`@gyblos/node/receipts` owns local receipt orchestration and bounded
persistence. The protocol owns wire records, core owns receipt policy, and the
node owns signers, lifecycle and private files. The Iroh adapter stays
storage-agnostic. The receipt uploader (`receipt-uploader*.ts`) sends a release
build's receipts to the metrics collector; an upload failure only delays the
upload and never blocks serving. Receipt failures and metadata calls never enter
inference failover. See [receipts.md](receipts.md).

`@gyblos/identity/resolution` owns pinned, bounded read-only account resolution
in the 8004 agent registry. `@gyblos/core/identity-policy` owns manual
precedence and scoped binding decisions without SDKs or I/O. The node's
`identity-state*` modules keep durable buyer metadata, and `identity-verifier`
composes registry reads with it. Opt-in buyer admission uses these APIs;
explicit manual trust remains available. See
[identity.md](identity.md#read-only-resolution-and-trust-policy).

## Local data

`packages/config/src/home.ts` owns every local path as a pure function of the
environment. No other module builds `.local/...` paths.

```text
$GYBLOS_HOME (default .local/gyblos from a checkout, ~/.gyblos for the packaged
              release, /data in the Docker image)
  seller.env, service.log   the seller service's private environment and log
  buyer/     role.json, node.key, selection.json, trust.json, api-keys.json,
             journals, locks, status, telemetry/, diagnostics/, receipts/,
             payments/, measurements
  seller/    role.json, node.key, owner key (a paid seller also has payment
             keys), payments/ (ledger and lock), status, receipts/, public
             sequence
  artifacts/ tokenizer/ (public, hash-pinned, shared), ollama-models/ (lab cache)
$GYBLOS_LAB_HOME (default .local/lab)
  lab config, keys, journals, measurements, facilitator-diagnostics/, identity/
```

Payment adapters receive journal and lock paths from their callers, which take
them from this layout. The lab shares `artifacts/` as a public cache and never
reads or writes a role directory. The node refuses to start when a legacy path
exists and the new home is missing; see
[running-a-node.md](running-a-node.md#local-home).

Named values follow their readers. HTTP-over-Iroh framing limits and stream
deadlines are `transport-iroh` constants, the offer lifetime is a core trust
rule, call and proof bounds belong to the buyer app, and only operator-tunable
capacity, rate, timeout and port values stay in `config` (`TRANSPORT_LIMITS`,
`TRANSPORT_TIMEOUTS`, `PORTS`).
