# Node configuration file (`gyblos.toml`)

A node can be described by one TOML file, `gyblos.toml`, as decided in vault
GYB-DOC-026. This page is its reference. The seller daemon (`pnpm node:start`)
reads it at startup; see [Seller startup](#seller-startup) for what it honors
today. `gyblos doctor` checks a seller before startup
([Seller preflight](#seller-preflight-gyblos-doctor)); `gyblos init` comes
later.

## Validate a file

```sh
pnpm gyblos config validate --config path/to/gyblos.toml   # default: ./gyblos.toml
```

On success it prints `OK`, every effective setting with where it came from
(flag, environment variable, file key or default), the offers, and the secret
variables by name with `set` or `not set`. On failure it prints one line per
problem, an issue code and a key path such as
`NON_CANONICAL_DECIMAL  offers[1].price.input_per_mtok`. Warnings go to standard
error as `warning` followed by a code and a key path, for example
`warning  REASONING_UNVERIFIED  offers[0].reasoning`, and never fail the file.
The exit code is `0` for a valid configuration and `1` otherwise (including
usage errors).

The command never prints a value that came from the environment, only the
variable's name, and issue lines never include the value that failed. URLs from
the file or defaults (`rpc_url`, relays, `discovery.url`, engine `url`) are
printed as their origin only (`scheme://host[:port]`), followed by
`<path hidden>` when the URL has a path, because providers such as Alchemy and
QuickNode put the API key in the path. A TOML syntax error reports a line and
column only.

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

Environment variables keep exactly their current meaning. The seller still needs
a file, because only `[[offers]]` lists what it serves:

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
- a `*_env` value that looks like a pasted token rather than a variable name:
  characters a variable name cannot hold, or at least 24 characters with a run
  of 16 or more letters and digits that includes a digit;
- a URL with user info or a credential-named query parameter, and any query on
  `node.rpc_url` (RPC providers put keys there). A keyed RPC URL belongs in
  `GYBLOS_RPC_URL`.

Unknown key names that look like tokens by the same rule are reported as
`<key>`. These checks catch common mistakes; they cannot recognize every secret,
for example a token embedded in a URL path (which `config validate` does not
print). Review a file before sharing it.

## File reference (version 1)

`version = 1` and a `[node]` table with `network` are required; everything else
is optional. Unknown keys are errors (`UNKNOWN_KEY`). Integer settings
(`version`, the free caps, `[limits]`) must be TOML integers: a float such as
`1.0`, `10.0` or `1e3` is `WRONG_TYPE`, and an integer too large for the setting
is out of range (`UNSUPPORTED_VERSION`, `INVALID_CAP` or `INVALID_LIMIT`),
however many digits it has.

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
- `[limits]`: seller capacity (see [Seller limits](#seller-limits)).
- `[[offers]]`, at most 32, each model at most once (aliases count as the same
  model):
  - `model`: a catalog id or alias from `packages/protocol/src/models.ts` (for
    example `gpt-oss-20b`, `qwen3-30b-a3b`, `qwen3:0.6b`), or any identifier
    with `custom = true`. A catalog model with `custom = true` is refused.
  - `engine`: `kind` (`ollama`, `openai` or `anthropic`), `url` (https; plain
    http only for `127.0.0.1`, `localhost`, `[::1]` or `host.docker.internal`),
    optional `api_key_env` and `upstream_model` (the name the engine expects).
  - `reasoning`: non-empty list of distinct levels from `off`, `low`, `medium`,
    `high` (GYB-DOC-028). For a catalog model with verified levels (see
    [Reasoning levels per model](#reasoning-levels-per-model)) every listed
    level must be one the model supports, otherwise `REASONING_UNSUPPORTED` at
    `offers[i].reasoning[j]`; when omitted, the model's default level is used.
    For a custom model or a catalog model without verified levels any such list
    is accepted, the default is `["off"]`, and the offer gets the
    `REASONING_UNVERIFIED` warning.
  - exactly one of:
    - `price = { input_per_mtok, output_per_mtok, currency = "USDC" }`: USDC per
      million tokens as decimal strings. Trailing fractional zeros are accepted
      and dropped, so `"0.10"`, `"1.50"` and `"2.0"` become `"0.1"`, `"1.5"` and
      `"2"` in the typed config. A sign, exponent, leading zero (`"00.1"`) or
      empty part (`"1."`, `".5"`) is `NON_CANONICAL_DECIMAL`; more than 4
      integer digits or more than 6 decimals after dropping trailing zeros is
      `PRICE_OUT_OF_RANGE`; both sides zero is `PRICE_ZERO`;
    - `free = { daily_token_cap, per_buyer_cap }`: positive integers, the
      per-buyer cap not above the daily cap.

At seller startup an offer becomes the node's public v2 listing (see
[Seller startup](#seller-startup)). Free offers use isolated complete-response
and streaming free execution channels; both share the same replay state and
free-cap handler. No paid-v2 execution is enabled.

### Price unit

A `gyblos.toml` price is USDC per million tokens. Protocol v2 will charge in
USDC atomic units (10^-6 USDC) per million tokens; that protocol change is
pending and lands separately. Because a price has at most 6 decimals, the
conversion is exact: atomic per million tokens = USDC per million tokens × 10^6.
`pricePerMtokToAtomicPerMtok` (from `@gyblos/node/node-config`) performs it, for
example `"0.1"` → `100000n`, `"1.5"` → `1500000n`, `"0.000001"` → `1n`.

### Reasoning levels per model

The catalog (`MODEL_CATALOG` in `packages/protocol/src/models.ts`) declares the
levels each model supports, from the closed set `off`, `low`, `medium`, `high`
(GYB-DOC-028). A model with only a thinking on/off switch uses `off` and `high`.
`null` means the levels were not verified from a primary model source, or the
vendor's levels do not map one-to-one onto the closed set; such models are
accepted like custom models, with a warning. Sources checked on 2026-10-24.

| Catalog id            | Levels                  | Default | Primary source                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen3-30b-a3b`       | `off`, `high`           | `off`   | [Qwen/Qwen3-30B-A3B model card](https://huggingface.co/Qwen/Qwen3-30B-A3B): `enable_thinking` hard switch between thinking and non-thinking modes.                                                                                                                                                                                                         |
| `qwen3-235b-a22b`     | `off`, `high`           | `off`   | [Qwen/Qwen3-235B-A22B model card](https://huggingface.co/Qwen/Qwen3-235B-A22B): same `enable_thinking` switch.                                                                                                                                                                                                                                             |
| `qwen3-0.6b`          | `off`, `high`           | `off`   | [Qwen/Qwen3-0.6B model card](https://huggingface.co/Qwen/Qwen3-0.6B): same `enable_thinking` switch.                                                                                                                                                                                                                                                       |
| `gpt-oss-120b`        | `low`, `medium`, `high` | `low`   | [OpenAI gpt-oss model card](https://cdn.openai.com/pdf/419b6906-9da6-406c-a19d-1bb078ac7637/oai_gpt-oss_model_card.pdf) (three reasoning levels) and the [harmony guide](https://developers.openai.com/cookbook/articles/openai-harmony) (vendor default medium; the offer default is low because gpt-oss always reasons and thinking is not metered yet). |
| `gpt-oss-20b`         | `low`, `medium`, `high` | `low`   | Same as `gpt-oss-120b`; [openai/gpt-oss-20b model card](https://huggingface.co/openai/gpt-oss-20b).                                                                                                                                                                                                                                                        |
| `llama-3.3-70b`       | `off`                   | `off`   | [meta-llama/Llama-3.3-70B-Instruct model card](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct): an instruction-tuned text model with no reasoning mode.                                                                                                                                                                                          |
| `gemma-4-26b`         | `off`, `high`           | `off`   | [google/gemma-4-26B-A4B-it model card](https://huggingface.co/google/gemma-4-26B-A4B-it): the `<\|think\|>` system-prompt token turns thinking on or off; no graded levels.                                                                                                                                                                                |
| `deepseek-v4.1-flash` | `null`                  |         | [deepseek-ai/DeepSeek-V4.1-Flash model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash): reasoning effort is an integer from 1 to 100 and the card does not document how to turn thinking off.                                                                                                                                                |
| `kimi-k3`             | `null`                  |         | [moonshotai/Kimi-K3 model card](https://huggingface.co/moonshotai/Kimi-K3): thinking is always on, `reasoning_effort` `low`, `high` or `max` (default `max`).                                                                                                                                                                                              |
| `glm-5.3-flash`       | `null`                  |         | [zai-org/GLM-5.3-Flash model card](https://huggingface.co/zai-org/GLM-5.3-Flash): `reasoning_effort` `low`, `high` or `max` (default `max`); no off level documented.                                                                                                                                                                                      |

The Qwen3 cards default to thinking on, and the Gemma 4 card states no default.
The offer default for both is `off`: thinking is not metered yet, and the Ollama
adapter runs Qwen3 with thinking disabled (GYB-DOC-028 decisions 4 and 5).
gpt-oss always reasons and has no `off`; its vendor default is `medium`, but the
offer default is `low` for the same reason (founder decision 2026-10-24).
Mapping DeepSeek's 1-100 effort and the `low`/`high`/`max` scales of Kimi K3 and
GLM 5.3 Flash onto the closed set is a later decision, so those entries stay
`null`.

**Qwen3 30B on Ollama.** Ollama's bare `qwen3:30b-a3b` tag now points at the
thinking-only `Qwen3-30B-A3B-Thinking-2507` build, which cannot turn thinking
off. The catalog alias is therefore the hybrid `qwen3:30b-a3b-q4_K_M`, and the
bare tag is no longer an alias: a file with `model = "qwen3:30b-a3b"` fails with
`UNKNOWN_MODEL`. Use `model = "qwen3-30b-a3b"` (or the hybrid alias) and set the
engine's `upstream_model = "qwen3:30b-a3b-q4_K_M"`. The validator does not check
`upstream_model`, so pointing it at the thinking-only tag would serve a model
that ignores `off`.

The JSON Schema checks only the closed set; the per-model rule is enforced by
the validator.

## Seller startup

`pnpm node:start` reads `GYBLOS_CONFIG` (a path; it must exist) or, when that
variable is unset, `./gyblos.toml`. Relative paths resolve against the daemon's
working directory, which is the repository root under `pnpm node:start`. The
file must list the offer to serve: without a file, or without `[[offers]]`,
startup stops with `SELLER_OFFERS_MISSING`. An environment variable still
overrides the file's settings.

The daemon runs its own Ollama at `http://127.0.0.1:11436` and serves one free
offer, the pinned Qwen3 0.6B with reasoning `off`. Paid selling is off until it
returns as a payment plugin; a paid offer stops startup with
`SELLER_PAID_EXECUTION_UNAVAILABLE`. The v1 paid path remains in the lab gates
(`pnpm gate:*`) only.
[examples/seller-daemon.toml](../examples/seller-daemon.toml) is a file it
accepts as written; the other examples are valid files for future nodes but stop
this daemon. Today it honors:

| Setting                                                                                                                                               | Used                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `[transport]` `relay_only`, `bind`, `external_addr`                                                                                                   | yes                                                                                                                       |
| `[relays]` `urls`, `relay_token_env` (the token stays in that variable; relay errors still name `GYBLOS_RELAY_TOKEN`)                                 | yes                                                                                                                       |
| `[discovery]` `publish`, `url`                                                                                                                        | yes                                                                                                                       |
| `[limits]`                                                                                                                                            | yes, see [Seller limits](#seller-limits)                                                                                  |
| `[[offers]]`: at most one, for `qwen3-0.6b` (or `qwen3:0.6b`), engine `ollama` at `http://127.0.0.1:11436` without `api_key_env`, reasoning `["off"]` | yes                                                                                                                       |
| `free = {...}` on that offer                                                                                                                          | served over the free channel with daily total and per-buyer token caps                                                    |
| `price = {...}` on that offer                                                                                                                         | not yet: paid selling is off until phase 2, so a paid offer stops startup                                                 |
| `[node]` `data_dir`, `rpc_url`, `payout_wallet`                                                                                                       | not yet: the role files own them, so setting them in the file stops startup (`GYBLOS_HOME` overriding `data_dir` is fine) |
| `[buyer]`                                                                                                                                             | ignored by the seller                                                                                                     |

Startup stops with a static code: `NODE_CONFIG_INVALID`,
`SELLER_SETTING_UNSUPPORTED`, `SELLER_OFFERS_MISSING`,
`SELLER_OFFER_COUNT_UNSUPPORTED`, `SELLER_OFFER_MODEL_UNSUPPORTED`,
`SELLER_OFFER_ENGINE_UNSUPPORTED`, `SELLER_OFFER_REASONING_UNSUPPORTED` or
`SELLER_PAID_EXECUTION_UNAVAILABLE`. `pnpm gyblos doctor` also names the
`[[offers]]` entry a code is about.

`pnpm gyblos config validate --config "$GYBLOS_CONFIG"` explains file problems
(it does not read `GYBLOS_CONFIG`, does not check the `SELLER_*` limits above,
and also checks `GYBLOS_RPC_URL`, which the daemon ignores).

Most invalid environment values are now caught when settings load, before Ollama
starts, and report `NODE_CONFIG_INVALID`. Before, they failed later with other
codes: an invalid `GYBLOS_RELAYS` or `GYBLOS_RELAY_ONLY=1` with
`GYBLOS_IROH_EXTERNAL_ADDR` failed when binding the endpoint, and an invalid
`GYBLOS_DISCOVERY_PUBLISH` (such as `yes`), or an invalid `GYBLOS_DISCOVERY_URL`
while publishing, with `INVALID_ROLE_CONFIGURATION`. Malformed
`GYBLOS_IROH_BIND` or `GYBLOS_IROH_EXTERNAL_ADDR` socket addresses still fail
when binding, as before. `GYBLOS_RPC_URL` does not affect the daemon, which
reads its RPC from the role file.

## Seller limits

`[limits]` sets how much one seller accepts. Every key is optional; an omitted
key keeps the built-in value, so a file without `[limits]` behaves as before.
Each value is an integer from 1 to a hard ceiling, so a typo cannot let one
seller exhaust its machine. A value out of range is `INVALID_LIMIT`, and startup
stops with `NODE_CONFIG_INVALID`.

| Key                          | Default | Ceiling | Meaning                                         |
| ---------------------------- | ------- | ------- | ----------------------------------------------- |
| `max_connections`            | 8       | 64      | open buyer connections in total                 |
| `requests_per_minute`        | 30      | 120     | requests per buyer NodeId per minute            |
| `global_requests_per_minute` | 256     | 1024    | requests per minute across all buyers           |
| `max_free_buyers_per_day`    | 1024    | 65536   | distinct buyers a free offer serves per UTC day |

```toml
[limits]
max_connections = 16
requests_per_minute = 60
global_requests_per_minute = 1024
```

Each connected buyer reserves its `requests_per_minute` from the global budget,
so the budget must cover a full pool:
`max_connections × requests_per_minute ≤ global_requests_per_minute`, with the
default for any key the file omits (the defaults give 8 × 30 = 240 ≤ 256).
Otherwise later buyers would be refused and one buyer could hold the whole
budget, so the file is refused with `INVALID_LIMIT` on the first key it sets
among `global_requests_per_minute`, `requests_per_minute` and `max_connections`.
The editor schema cannot check this rule; `config validate` does.

A free chat usually counts as two requests (its quote and its execution), so 30
per minute is about 15 free chats per buyer.

Free execution opens one connection per request, so the connection-attempt
limits rise with a raised request rate (per buyer and per source to
`requests_per_minute`, in total to `global_requests_per_minute`) and never fall
below their built-in values. Up to 8 handshakes are pending at once whatever
`max_connections` is, so a large pool fills gradually.

Request concurrency and connections per buyer are not configurable. The daemon's
managed Ollama runs one generation at a time, so each buyer has one request in
flight and the seller at most two in flight (one running, one queued; one for a
free offer). Each buyer keeps one control and one data connection. Wire sizes
and deadlines protect the protocol, not capacity, and stay fixed. `[limits]` is
file-only: there are no `GYBLOS_*` variables for it, and the buyer ignores it.
`config validate` checks the section but does not print the values;
`pnpm gyblos doctor` prints the limits the seller will serve with.

## Seller preflight (`gyblos doctor`)

```sh
pnpm gyblos doctor                         # reads ./gyblos.toml, like node:start
GYBLOS_CONFIG=my.toml pnpm gyblos doctor   # the file node:start will read
```

`doctor` has no `--config` flag on purpose: it reads exactly the file
`pnpm node:start` reads (`GYBLOS_CONFIG`, else `./gyblos.toml`), so a passing
doctor and a starting node never look at different files. It runs, read-only,
the checks startup would fail on, and prints one line per check (`OK`, `WARN` or
`FAIL`) with a static code and a hint:

| Check       | What it verifies                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`    | the file and environment as seller startup reads them, with the same `NODE_CONFIG_INVALID` / `SELLER_*` codes (file problems are listed with their key paths)                                    |
| `home`      | no legacy `.local` layout under the role, tokenizer or Ollama directories                                                                                                                        |
| `role`      | the seller `role.json` exists and is valid (`ROLE_MISSING` hints `node:setup`)                                                                                                                   |
| `keys`      | the key files startup loads, the owner and node keys, are regular, non-symlinked files owned by you with mode 0600. Metadata only, so a corrupt key is still found only at startup               |
| `sequence`  | the seller directory is mode 0700 and its public-sequence file is valid for this node; a leftover sequence lock fails, because it blocks every publication (inspect it, never delete it blindly) |
| `tokenizer` | the pinned tokenizer files are present and match their hashes                                                                                                                                    |
| `ollama`    | an executable `ollama` file is on `PATH` (it is not run)                                                                                                                                         |
| `model`     | the pinned model's manifest is in the managed models directory (startup never downloads it; only Ollama can confirm it works)                                                                    |
| `ports`     | nothing answers on `127.0.0.1:11436`                                                                                                                                                             |
| `relays`    | relay URLs and token as the endpoint would build them (the token is never printed)                                                                                                               |

It then prints the seller's public **NodeId and owner** address from
`role.json`; share those to be enrolled in a discovery index. The exit code is 0
when no check fails (warnings do not fail) and 1 otherwise. It starts, spawns
and writes nothing. It never prints the home location, the RPC URL, the relay
token or key material, and only reaches loopback ports. Memory headroom, key
contents and the NodeId matching `node.key` are checked at startup only. With a
valid configuration it also prints the effective
[seller limits](#seller-limits).

## Issue codes

`TOML_SYNTAX`, `FILE_NOT_FOUND`, `FILE_UNREADABLE`, `FILE_TOO_LARGE` (over 64
KiB), `UNKNOWN_KEY`, `MISSING_KEY`, `WRONG_TYPE`, `INVALID_VALUE`,
`UNSUPPORTED_VERSION`, `MAINNET_UNSUPPORTED`, `INVALID_ADDRESS`, `INVALID_URL`,
`INSECURE_URL`, `INVALID_ENV_NAME`, `INLINE_SECRET`, `DUPLICATE_VALUE`,
`TOO_MANY`, `UNKNOWN_MODEL`, `CUSTOM_MODEL_IN_CATALOG`, `NON_CANONICAL_DECIMAL`,
`PRICE_OUT_OF_RANGE`, `PRICE_ZERO`, `PRICING_CONFLICT`, `PRICING_MISSING`,
`INVALID_CAP`, `RELAY_ONLY_CONFLICT`, `INVALID_LIMIT`, `REASONING_UNSUPPORTED`.
The canonical list is `NODE_CONFIG_ISSUE_CODES` in
`packages/node/src/constants.ts`.

Warnings: `ENV_SWITCH_NOT_STRICT` (a switch variable other than `1` or `0`) and
`REASONING_UNVERIFIED` (an offer whose levels cannot be checked against the
catalog). The canonical list is `NODE_CONFIG_WARNING_CODES`.

## Editor support and examples

The JSON Schema is
[packages/node/schemas/gyblos.schema.json](../packages/node/schemas/gyblos.schema.json)
(draft-07). The examples start with a `#:schema` comment, which TOML editors
based on Taplo (such as Even Better TOML) use for completion and inline errors.
The schema cannot express a few cross-field rules (per-buyer cap above the daily
cap, a model offered twice through an alias, relays that are equal after
normalization, the reasoning levels a catalog model supports);
`gyblos config validate` is authoritative.

Commented examples to copy, all valid. Their `#:schema` line is relative to this
repository; in a copy elsewhere, update or delete it. Reasoning levels follow
each model (GYB-DOC-028): gpt-oss offers `low`, `medium` and `high` (no `off`);
Qwen3 thinking is on or off, written `["off", "high"]`. The custom model in
`anthropic-reseller.toml` validates with the `REASONING_UNVERIFIED` warning.

| File                                                                    | Shows                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| [examples/ollama-local.toml](../examples/ollama-local.toml)             | One model from an Ollama on this machine.                    |
| [examples/lm-studio.toml](../examples/lm-studio.toml)                   | LM Studio's OpenAI-compatible server, gpt-oss effort levels. |
| [examples/openai-reseller.toml](../examples/openai-reseller.toml)       | Reselling an OpenAI-compatible API with `api_key_env`.       |
| [examples/anthropic-reseller.toml](../examples/anthropic-reseller.toml) | An Anthropic-compatible API and a custom model.              |
| [examples/free-offer.toml](../examples/free-offer.toml)                 | A free offer with caps, Docker host engine, publication off. |
| [examples/seller-daemon.toml](../examples/seller-daemon.toml)           | What the seller daemon serves today; it starts as written.   |
| [examples/multi-model.toml](../examples/multi-model.toml)               | Several models on one node.                                  |

## Code

- `@gyblos/node/node-config`: `parseNodeConfig`, `validateNodeConfig`,
  `readNodeConfigFile`, `pricePerMtokToAtomicPerMtok` and the `NodeConfig` type;
  a valid result also carries `warnings`.
- `@gyblos/node/node-config-resolve`: `resolveNodeConfig({ file, env, flags })`,
  returning settings, origins, secret references and warnings, or issues.
- `apps/node/src/cli.ts`: the `gyblos` command (`pnpm gyblos`).
