# Repository documentation

These pages describe how Gyblos Node works and how to build, run and change it.
To run a seller or use the desktop app, start with the public guides at
[docs.gyblos.com](https://docs.gyblos.com), in English and Spanish; their source
is [apps/docs](../apps/docs/README.md).

## Start here

- [README](../README.md): what Gyblos is, where to start and how to develop
  locally.
- [Known limitations](limitations.md): what Gyblos doesn't do or hasn't proven.
- [Public decisions](public-decisions.md): decided and proposed product and
  engineering directions.
- [Architecture](architecture.md): packages, apps and the dependency rule.

## Run a node

- [Running a node from a checkout](running-a-node.md): a seller or buyer from a
  checkout, the Docker seller, the install script and the packaged seller.
- [Configuration](configuration.md): the `config.toml` file, its validation and
  `gyblos doctor`.
- [Guided buyer setup](buyer-init.md): `pnpm buyer:init` and the buyer's
  `selection.json`.
- [Diagnostics](diagnostics.md): content-free operational logs and how to read
  them.

## Payments

- [Payments](payments.md): the payment paths and the x402 integration.
- [Payment sessions](payment-sessions.md): reusable buyer-authorized payment
  sessions, seller capacity and buyer routing.
- [Recovery and reconciliation](recovery.md): what to do when a paid call fails
  halfway.
- [Buyer API keys](buyer-api-keys.md): delegated API keys with a spending limit,
  created in the desktop app.
- [PayPal Sandbox prototype](paypal-sandbox.md): a local single-seller prototype
  with simulated payments.

## Discovery and identity

- [Discovery](discovery.md): the discovery client, trust rules and the index
  wire contract.
- [Identity](identity.md): node identity in the 8004 agent registry.

## Receipts and telemetry

- [Receipts](receipts.md): signed receipts, the local receipt receiver and its
  policy.
- [Telemetry](telemetry.md): local content-free telemetry events and the
  optional OpenTelemetry adapter.

## Desktop app

- [Desktop app](desktop.md): building, running and packaging the Electron app.
- [Desktop wallet backup](desktop-backup.md): the encrypted wallet backup
  format.

## Contributing and standards

- [CONTRIBUTING](../CONTRIBUTING.md): how to contribute, including with AI
  tools.
- [AGENTS](../AGENTS.md): the repository rules.
- [Code standards](code-standards.md): detailed style behind the rules.
- [Tests](../tests/README.md): test layout, native skips and acceptance runs.
- [Technology stack](stack.md): what the repository runs on and why.
- [Static analysis](static-analysis.md): the Semgrep workflow.
- [Third-party notices](third-party-notices.md): bundled third-party material
  and its terms.
- [Protocol specification](../packages/protocol/SPEC.md): wire contracts,
  signing domains and golden vectors.

## Operations reference

- [Discovery index](discovery-index.md): the discovery index Worker, its
  endpoints, security model and storage.
- [Metrics collector](metrics-collector.md): the metrics collector Worker that
  receives receipts and observations and serves public stats.
- [Repository maintenance](repository-maintenance.md): maintainer
  responsibilities for the public repository.
- [AI security review](../tooling/security-review/README.md): the automated
  security review tooling.

## Lab

- [lab/README.md](../lab/README.md): lab devnet checks, the local facilitator,
  synthetic acceptance runs and published evidence.
