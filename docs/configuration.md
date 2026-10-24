# Node configuration file (`gyblos.toml`)

A node can be described by one TOML file, `gyblos.toml`, as decided in vault
GYB-DOC-026. This page is its reference. Today the file is **validated and
resolved but not yet read by `pnpm node:start`**: startup still uses the
`GYBLOS_*` environment variables in [running-a-node.md](running-a-node.md).
Wiring the file into startup, `gyblos init` and `gyblos doctor` come later.

## Validate a file

```sh
pnpm gyblos config validate --config path/to/gyblos.toml   # default: ./gyblos.toml
```

On success it prints `OK`, every effective setting with where it came from
(flag, environment variable, file key or default), the offers, and the secret
variables by name with `set` or `not set`. On failure it prints one line per
problem, an issue code and a key path such as
`NON_CANONICAL_DECIMAL  offers[1].price.input_per_mtok`. The exit code is `0`
for a valid configuration and `1` otherwise (including usage errors).

The command never prints a value that came from the environment, only the
variable's name, and issue lines never include the value that failed. A TOML
syntax error reports a line and column only.

The command also checks the current `GYBLOS_*` environment, because those
variables override the file.

## Precedence

For each setting, the first source that sets it wins:

1. CLI flags (for future `gyblos start`; the resolver already accepts them).
2. `GYBLOS_*` environment variables.
3. `gyblos.toml`.
4. Built-in defaults.

| Setting               | Flag                   | Environment                 | File key                  | Default                           |
| --------------------- | ---------------------- | --------------------------- | ------------------------- | --------------------------------- |
| network               |                        |                             | `node.network`            | `devnet`                          |
| home                  | `--home`               | `GYBLOS_HOME`               | `node.data_dir`           | `.local/gyblos`                   |
| RPC URL               | `--rpc-url`            | `GYBLOS_RPC_URL`            | `node.rpc_url`            | `https://api.devnet.solana.com`   |
| payout wallet         | `--payout-wallet`      |                             | `node.payout_wallet`      | unset                             |
| relays                | `--relay` (repeated)   | `GYBLOS_RELAYS`             | `relays.urls`             | `https://na1.relay.gyblos.com/`   |
| relay token variable  |                        |                             | `relays.relay_token_env`  | `GYBLOS_RELAY_TOKEN`              |
| seller relay-only     | `--relay-only`         | `GYBLOS_RELAY_ONLY`         | `transport.relay_only`    | off                               |
| Iroh bind address     | `--iroh-bind`          | `GYBLOS_IROH_BIND`          | `transport.bind`          | unset                             |
| Iroh external address | `--iroh-external-addr` | `GYBLOS_IROH_EXTERNAL_ADDR` | `transport.external_addr` | unset                             |
| buyer relay-only      | `--buyer-relay-only`   | `GYBLOS_BUYER_RELAY_ONLY`   | `buyer.relay_only`        | off                               |
| discovery publication | `--discovery-publish`  | `GYBLOS_DISCOVERY_PUBLISH`  | `discovery.publish`       | off                               |
| discovery index URL   | `--discovery-url`      | `GYBLOS_DISCOVERY_URL`      | `discovery.url`           | `https://discovery.gyblos.com/v1` |
| offers                |                        |                             | `[[offers]]`              | none                              |

Environment variables keep exactly their current meaning, so a node with no file
behaves as before:

- `GYBLOS_HOME`, `GYBLOS_IROH_BIND` and `GYBLOS_IROH_EXTERNAL_ADDR` count only
  when non-empty.
- `GYBLOS_RELAY_ONLY` and `GYBLOS_BUYER_RELAY_ONLY` are on only for `1`; any
  other value is off. A value other than `1` or `0` (including empty) adds the
  warning `ENV_SWITCH_NOT_STRICT`, because it also overrides the file.
- `GYBLOS_DISCOVERY_PUBLISH` accepts `1` or `0`; anything else is an error.
- `GYBLOS_DISCOVERY_URL` from the environment is checked only when publishing,
  as today. Flag and file URLs are always checked.

A relay-only seller with an external address is refused (`RELAY_ONLY_CONFLICT`),
whichever source set each value.

## Secrets

Secrets never go in the file. The file names the environment variable that holds
a secret:

```toml
[relays]
relay_token_env = "GYBLOS_RELAY_TOKEN"

[[offers]]
engine = { kind = "openai", url = "https://api.example.com/v1", api_key_env = "UPSTREAM_API_KEY" }
```

The validator refuses, with `INLINE_SECRET`:

- a key named like a credential (`api_key`, `token`, `secret`, `password`,
  `private_key`, `auth`, `credentials`, ...) holding a literal value, anywhere
  in the file, including inside unknown tables;
- a `*_env` value that looks like a pasted token rather than a variable name;
- a URL with user info or a credential-named query parameter, and any query on
  `node.rpc_url` (RPC providers put keys there). A keyed RPC URL belongs in
  `GYBLOS_RPC_URL`.

These checks catch common mistakes; they cannot recognize every secret, for
example a token embedded in a URL path. Review a file before sharing it.

## File reference (version 1)

`version = 1` and a `[node]` table with `network` are required; everything else
is optional. Unknown keys are errors (`UNKNOWN_KEY`).

- `[node]`
  - `network`: `"devnet"`. `"mainnet"` is refused with `MAINNET_UNSUPPORTED`.
  - `data_dir`: local home, same meaning as `GYBLOS_HOME` (relative paths
    resolve against the working directory).
  - `payout_wallet`: a Solana address; a cold address, never a node hot key.
  - `rpc_url`: https, or http on loopback; no credentials or query.
- `[relays]`: `urls` (1 to 8 HTTPS origins without path, query or credentials;
  duplicates refused after normalization) and `relay_token_env`.
- `[transport]`: `relay_only` (boolean), `bind` and `external_addr` (`ip:port`,
  IPv6 in brackets).
- `[buyer]`: `relay_only` (boolean).
- `[discovery]`: `publish` (boolean) and `url` (https, or http on loopback).
- `[[offers]]`, at most 32, each model at most once (aliases count as the same
  model):
  - `model`: a catalog id or alias from `packages/protocol/src/models.ts` (for
    example `gpt-oss-20b`, `qwen3-30b-a3b`, `qwen3:0.6b`), or any identifier
    with `custom = true`. A catalog model with `custom = true` is refused.
  - `engine`: `kind` (`ollama`, `openai` or `anthropic`), `url` (https; plain
    http only for `127.0.0.1`, `localhost`, `[::1]` or `host.docker.internal`),
    optional `api_key_env` and `upstream_model` (the name the engine expects).
  - `reasoning`: non-empty list of distinct levels from `off`, `low`, `medium`,
    `high` (GYB-DOC-028); default `["off"]`.
  - exactly one of:
    - `price = { input_per_mtok, output_per_mtok, currency = "USDC" }`: USDC per
      million tokens as canonical decimal strings: no sign, exponent, leading
      zeros or trailing fractional zeros (`"0.1"`, not `"0.10"`), at most 4
      integer digits and 6 decimals, not both zero;
    - `free = { daily_token_cap, per_buyer_cap }`: positive integers, the
      per-buyer cap not above the daily cap.

Prices and free caps are validated but not yet enforced: the paid path still
uses the fixed proof-of-concept prices.

## Issue codes

`TOML_SYNTAX`, `FILE_NOT_FOUND`, `FILE_UNREADABLE`, `FILE_TOO_LARGE` (over 64
KiB), `UNKNOWN_KEY`, `MISSING_KEY`, `WRONG_TYPE`, `INVALID_VALUE`,
`UNSUPPORTED_VERSION`, `MAINNET_UNSUPPORTED`, `INVALID_ADDRESS`, `INVALID_URL`,
`INSECURE_URL`, `INVALID_ENV_NAME`, `INLINE_SECRET`, `DUPLICATE_VALUE`,
`TOO_MANY`, `UNKNOWN_MODEL`, `CUSTOM_MODEL_IN_CATALOG`, `NON_CANONICAL_DECIMAL`,
`PRICE_OUT_OF_RANGE`, `PRICE_ZERO`, `PRICING_CONFLICT`, `PRICING_MISSING`,
`INVALID_CAP`, `RELAY_ONLY_CONFLICT`. The canonical list is
`NODE_CONFIG_ISSUE_CODES` in `packages/node/src/constants.ts`.

## Editor support and examples

The JSON Schema is
[packages/node/schemas/gyblos.schema.json](../packages/node/schemas/gyblos.schema.json)
(draft-07). The examples start with a `#:schema` comment, which TOML editors
based on Taplo (such as Even Better TOML) use for completion and inline errors.
The schema cannot express a few cross-field rules (per-buyer cap above the daily
cap, a model offered twice through an alias, relays that are equal after
normalization); `gyblos config validate` is authoritative.

Commented examples to copy, all valid:

| File                                                                    | Shows                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| [examples/ollama-local.toml](../examples/ollama-local.toml)             | One model from an Ollama on this machine.                   |
| [examples/lm-studio.toml](../examples/lm-studio.toml)                   | LM Studio's OpenAI-compatible server, all reasoning levels. |
| [examples/openai-reseller.toml](../examples/openai-reseller.toml)       | Reselling an OpenAI-compatible API with `api_key_env`.      |
| [examples/anthropic-reseller.toml](../examples/anthropic-reseller.toml) | An Anthropic-compatible API and a custom model.             |
| [examples/free-offer.toml](../examples/free-offer.toml)                 | A free offer with caps, Docker host engine, publication.    |
| [examples/multi-model.toml](../examples/multi-model.toml)               | Several models on one node.                                 |

## Code

- `@gyblos/node/node-config`: `parseNodeConfig`, `validateNodeConfig`,
  `readNodeConfigFile` and the `NodeConfig` type.
- `@gyblos/node/node-config-resolve`: `resolveNodeConfig({ file, env, flags })`,
  returning settings, origins, secret references and warnings, or issues.
- `apps/node/src/cli.ts`: the `gyblos` command (`pnpm gyblos`).
