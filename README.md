# Gyblos Node

Gyblos is a peer-to-peer network for AI inference: sellers run a node that
serves models, and buyers find them through a public discovery index and connect
directly or through a relay. Inference is free or paid per use in devnet USDC:
the buyer authorizes a ceiling, the seller charges only the tokens it used, and
the rest of the deposit returns to the buyer.

**Status:** experimental, Solana devnet only, not audited. Never use mainnet
keys. See the [known limitations](docs/limitations.md).

## Start here

| You want to                  | Go to                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run a seller                 | [Install a seller](https://docs.gyblos.com/en/sellers/beta-guide): install a Docker or native seller, register it with your invite code and list it.                                       |
| Use Gyblos                   | [Desktop app](https://docs.gyblos.com/en/buyers/desktop-app) for macOS (Apple Silicon), Windows x64 and Linux x64, or [use it from code](https://docs.gyblos.com/en/buyers/use-from-code). |
| Develop or contribute        | [Develop locally](#develop-locally) below, then [CONTRIBUTING.md](CONTRIBUTING.md).                                                                                                        |
| Get help or report a problem | [SUPPORT.md](SUPPORT.md); report vulnerabilities privately through [SECURITY.md](SECURITY.md).                                                                                             |

The public guides at [docs.gyblos.com](https://docs.gyblos.com) are in English
and Spanish. Their source is [apps/docs](apps/docs/README.md).

## How it fits together

```text
app ─▶ local buyer ══ Iroh (direct or relay) ══▶ seller node ─▶ engine
        │                                                         (Ollama, or an OpenAI- or
        ├─ finds sellers in the discovery index                    Anthropic-compatible API)
        ├─ checks each seller's owner in the 8004 agent registry
        └─ paid offers: payment channel on Solana devnet, settled per use
```

- The **seller node** serves each offer in its `config.toml`, free or paid.
- The **local buyer** verifies the seller's signed quote, then runs a free
  request, or pays for a priced one through a per-request payment channel (or a
  payment session, when the buyer has one configured). Its **buyer endpoint** is
  an OpenAI- and Anthropic-compatible HTTP API on your machine.
- The **desktop app** runs the same local buyer inside an Electron app.

## Data that leaves your machine

- Release builds (the Docker seller, the packaged seller and the desktop app)
  upload signed, content-free receipts to the metrics collector at
  `collector.gyblos.com`. Receipts have no opt-out.
- The same builds upload content-free observations. Set
  `GYBLOS_OBSERVATIONS=off` in the process environment to turn them off (for the
  Docker seller, add it to `seller.env`).
- A listed seller publishes signed public records (its catalog and presence) to
  the discovery index.
- A development checkout uploads nothing unless you set `GYBLOS_COLLECTOR_URL`.

Details:
[data and privacy](https://docs.gyblos.com/en/reference/data-and-privacy),
[receipts](docs/receipts.md) and [telemetry](docs/telemetry.md).

## Develop locally

### Prerequisites

- Node.js 24.22.1 or newer and the pnpm version pinned in
  [package.json](package.json). See the
  [toolchain setup](CONTRIBUTING.md#set-up-nodejs-and-pnpm).
- For native transport tests: macOS ARM64, Linux x64/ARM64 or Windows x64. There
  is no Intel Mac binding. On other platforms those cases skip, and a skip
  proves nothing.

No funded wallet, engine, Docker or network access is needed beyond installing
packages.

### Install and check

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs typecheck, lint and every product, standalone package and lab
test. It exits with status 0 when everything passes; report the passed, failed,
cancelled and skipped counts.

### Run from a checkout

- Seller: follow [running a seller and a buyer](docs/running-a-node.md). In
  short, prepare keys and the tokenizer, start an engine, run
  `pnpm gyblos seller init` to write `config.toml`, check it with
  `pnpm gyblos doctor` and start it with `pnpm node:start`.
- Buyer: run `pnpm buyer:init`, then `pnpm buyer:chat`. The defaults accept free
  quotes only, with zero spending and price ceilings. See
  [guided buyer setup](docs/buyer-init.md).
- Desktop app: `pnpm desktop:start`. See [desktop app](docs/desktop.md).
- Synthetic acceptance runs and lab devnet checks:
  [lab/README.md](lab/README.md).

### Common commands

| Command                                                  | What it does                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm gyblos <command>`                                  | The seller CLI: `seller init\|status\|register\|service`, `doctor`, `logs`, `config validate`. |
| `pnpm node:setup --role seller --mint MINT`              | Create isolated seller keys, without RPC or funding.                                           |
| `pnpm node:tokenizer`                                    | Download and verify the pinned tokenizer.                                                      |
| `pnpm node:start`                                        | Start the seller node.                                                                         |
| `pnpm buyer:init`                                        | Write the buyer's settings and identity, without network requests.                             |
| `pnpm buyer`, `buyer:chat`                               | Start the local buyer endpoint; or chat with it in the terminal.                               |
| `pnpm buyer:free`                                        | Start a buyer endpoint that runs free offers only.                                             |
| `pnpm buyer:agent`                                       | Print or write the settings that connect a coding agent to the buyer endpoint.                 |
| `pnpm buyer:reconcile:paid`, `buyer:withdraw:paid`       | Check open payment channels against devnet; move a stuck channel toward a refund.              |
| `pnpm desktop:build`, `desktop:start`, `desktop:package` | Build, run or package the desktop app.                                                         |
| `pnpm docs:dev`, `docs:test`                             | Preview the docs site; check its static export.                                                |
| `pnpm check`                                             | Typecheck, lint and all tests; run before every PR.                                            |
| `pnpm test`, `test:lab`, `tooling:test`                  | Product and standalone package tests (required checks); lab tests; tooling tests.              |
| `pnpm format`                                            | Format files and sort imports.                                                                 |

Replace `MINT` with the devnet USDC mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. The legacy paid v1 commands
(`buyer:start`, `buyer:trust`, `buyer:call`, `buyer:reconcile`) and the `gate:*`
commands work only with the lab; see
[lab/README.md](lab/README.md#legacy-v1-buyer).

Commands read settings from the environment and never load a `.env` file.
[.env.example](.env.example) lists the environment variables, and
[configuration](docs/configuration.md) covers `config.toml`.

## Repository layout

| Path        | Contents                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/`     | Executables: seller node and `gyblos` CLI, local buyer, desktop app, discovery index, metrics collector, local receipt receiver, docs site and explorer. |
| `packages/` | Libraries the apps share: protocol, policy, adapters and the node library.                                                                               |
| `lab/`      | Validation outside the product: devnet checks, a local facilitator and published evidence.                                                               |
| `tests/`    | Product and lab test suites; see [tests/README.md](tests/README.md).                                                                                     |
| `tooling/`  | Boundary checker, lint rules and build tools.                                                                                                            |

Package-by-package map: [docs/architecture.md](docs/architecture.md).

## Safety

- A timeout is not a refund. An uncertain payment blocks new payments until it
  is reconciled. Never delete `buyer.lock` or a journal to retry; follow
  [recovery](docs/recovery.md).
- Use only generated devnet keys. Never commit keys, tokens, journals or logs.

## Documentation

- [docs/README.md](docs/README.md): every repository document, grouped by
  audience.
- [docs.gyblos.com](https://docs.gyblos.com): guides for sellers and buyers.
- [packages/protocol/SPEC.md](packages/protocol/SPEC.md): the wire protocol.
- [AGENTS.md](AGENTS.md): repository rules for every contributor.

## License and community

Original code is licensed under [Apache 2.0](LICENSE). Third-party components
and marks keep their own terms; see the
[third-party notices](docs/third-party-notices.md). Contributions follow
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md). Gyblos: [gyblos.com](https://gyblos.com)
· [paper](https://gyblos.com/paper).
