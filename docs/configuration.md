# Node configuration file (`config.toml`)

This page is the complete reference for `config.toml`: every section, key,
default, environment override and issue code, as
`packages/node/src/node-config*.ts` parses them. The public
[configuration reference](https://docs.gyblos.com/en/reference/configuration) is
the operator subset for the Docker seller; start there if you run an invited
seller.

The seller node reads the file at startup ([Seller startup](#seller-startup)).
`gyblos seller init` writes a starting file with one free offer
([Seller](running-a-node.md#seller)), `gyblos config validate` checks a file,
and `gyblos doctor` checks a whole seller before it starts
([Seller preflight](#seller-preflight-gyblos-doctor)).

## Smallest valid file

`version` and `[node].network` are the only required keys. A seller also needs
at least one `[[offers]]` entry:

```toml
version = 1

[node]
network = "devnet"

[[offers]]
model = "qwen3-0.6b"
engine = { kind = "ollama", url = "http://127.0.0.1:11434/" }
reasoning = ["off"]
free = { daily_token_cap = 200000, per_buyer_cap = 20000 }
```

[examples/seller-daemon.toml](../examples/seller-daemon.toml) is the commented
version of this file.

## Which file is read

| Reader                                       | File                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `gyblos start` (`pnpm node:start`)           | `GYBLOS_CONFIG` if set (it must exist), else `./config.toml` if present; the packaged release reads `config.toml` in its home instead |
| `gyblos doctor`, `gyblos seller init`        | The same file as `gyblos start`                                                                                                       |
| `gyblos config validate`                     | `--config PATH`, else `./config.toml`; it ignores `GYBLOS_CONFIG`                                                                     |
| Local buyer (`[telemetry]`, `[diagnostics]`) | The same file as `gyblos start`; the buyer's role and `selection.json` own everything else                                            |

Relative paths resolve against the working directory, which is the repository
root under `pnpm node:start`. The rule lives in `nodeConfigPath`
(`@gyblos/node/node-config-file`).

## Validate a file

```sh
pnpm gyblos config validate --config path/to/config.toml
```

On success the first line is `PATH: OK (version 1)`. It then prints every
effective setting with its source (`default`, `file node.network`,
`env GYBLOS_HOME`), the offers, and each secret variable by name with `set` or
`not set`.

On failure it prints `PATH: INVALID (N issue(s))` and one line per problem: an
issue code and a key path, such as
`NON_CANONICAL_DECIMAL  offers[1].price.input_per_mtok`. Warnings go to standard
error as `warning` followed by a code and a key path, for example
`warning  REASONING_UNVERIFIED  offers[0].reasoning`; they never fail the file.
The exit code is `0` for a valid configuration and `1` otherwise, including
usage errors.

The command also checks the current `GYBLOS_*` environment, because those
variables override the file. An invalid environment prints
`PATH: file OK, environment INVALID`.

What it never prints:

- A value that came from the environment; only the variable's name.
- The value that failed; only its code and key path.
- A full URL. `rpc_url`, relays, `discovery.url` and engine `url` appear as
  their origin (`scheme://host[:port]`), followed by `<path hidden>` when the
  URL has a path, because providers such as Alchemy and QuickNode put the API
  key in the path.
- TOML source text. A syntax error reports a line and column only.

`config validate` does not check the seller-only refusals
([Startup codes](#startup-codes)), does not print `[limits]` or `[diagnostics]`,
and checks `GYBLOS_RPC_URL`, which the seller ignores. Use `gyblos doctor` for
the seller's view.

## Precedence and environment

For each setting, the first source that sets it wins:

1. `GYBLOS_*` environment variables.
2. `config.toml`.
3. Built-in defaults.

The resolver (`resolveNodeConfig`) also accepts programmatic flags above the
environment (`NODE_CONFIG_FLAGS`), but no `gyblos` command exposes them.

| Setting               | Environment                 | File key                  | Default                             |
| --------------------- | --------------------------- | ------------------------- | ----------------------------------- |
| network               |                             | `node.network`            | `devnet`                            |
| home                  | `GYBLOS_HOME`               | `node.data_dir`           | `.local/gyblos`                     |
| RPC URL               | `GYBLOS_RPC_URL`            | `node.rpc_url`            | `https://api.devnet.solana.com`     |
| payout wallet         |                             | `node.payout_wallet`      | unset                               |
| relays                | `GYBLOS_RELAYS`             | `relays.urls`             | `https://na1.relay.gyblos.com/`     |
| relay token variable  |                             | `relays.relay_token_env`  | `GYBLOS_RELAY_TOKEN`                |
| seller relay-only     | `GYBLOS_RELAY_ONLY`         | `transport.relay_only`    | off                                 |
| Iroh bind address     | `GYBLOS_IROH_BIND`          | `transport.bind`          | unset                               |
| Iroh external address | `GYBLOS_IROH_EXTERNAL_ADDR` | `transport.external_addr` | unset                               |
| buyer relay-only      | `GYBLOS_BUYER_RELAY_ONLY`   | `buyer.relay_only`        | off                                 |
| discovery publication | `GYBLOS_DISCOVERY_PUBLISH`  | `discovery.publish`       | off                                 |
| discovery index URL   | `GYBLOS_DISCOVERY_URL`      | `discovery.url`           | `https://discovery.gyblos.com/v1`   |
| file telemetry        |                             | `telemetry.file`          | off                                 |
| diagnostics           |                             | `[diagnostics]`           | enabled, level `warn`               |
| seller limits         |                             | `[limits]`                | see [Seller limits](#seller-limits) |
| offers                |                             | `[[offers]]`              | none                                |

How the environment is read:

- `GYBLOS_HOME`, `GYBLOS_IROH_BIND` and `GYBLOS_IROH_EXTERNAL_ADDR` count only
  when non-empty.
- `GYBLOS_RELAY_ONLY` and `GYBLOS_BUYER_RELAY_ONLY` are on only for `1`. Any
  other value is off; a value other than `1` or `0` (including empty) also adds
  the warning `ENV_SWITCH_NOT_STRICT`, because it still overrides the file.
- `GYBLOS_DISCOVERY_PUBLISH` accepts `1` or `0`; anything else is an error.
- `GYBLOS_DISCOVERY_URL` from the environment is checked only when publication
  is on. A file URL is always checked.
- `GYBLOS_RELAYS` is a comma-separated list of relay origins.
- A relay-only seller with an external address is refused
  (`RELAY_ONLY_CONFLICT`), whichever source set each value.

The packaged release (`GYBLOS_PACKAGED=1`, set by its launcher) keeps its home
in `~/.gyblos` and reads `config.toml` there. The resolver's reported default is
still `.local/gyblos`, so `config validate` shows that default unless
`GYBLOS_HOME` is set. The seller image sets `GYBLOS_CONTAINER=1`, which changes
only how `gyblos seller status` finds the daemon.

## Secrets

Secrets never go in the file. The file names the environment variable that holds
each secret:

```toml
[relays]
relay_token_env = "GYBLOS_RELAY_TOKEN"

[[offers]]
engine = { kind = "openai", url = "https://api.example.com/v1", api_key_env = "UPSTREAM_API_KEY", context_tokens = 131072 }
```

The validator refuses, with `INLINE_SECRET`:

- A key named like a credential (`api_key`, `token`, `secret`, `password`,
  `private_key`, `auth`, `credentials` and similar) that holds a literal value,
  anywhere in the file, including inside unknown tables.
- A `*_env` value that looks like a pasted token rather than a variable name:
  characters a variable name cannot hold, or at least 24 characters with a run
  of 16 or more letters and digits that includes a digit.
- A URL with user info or a credential-named query parameter, and any query on
  `node.rpc_url`. A keyed RPC URL belongs in `GYBLOS_RPC_URL`.

Unknown key names that look like tokens by the same rule are reported as
`<key>`. These checks catch common mistakes but cannot recognize every secret,
such as a token in a URL path. Review a file before you share it.

## File reference (version 1)

Unknown keys are errors (`UNKNOWN_KEY`). Integer settings (`version`, the free
caps, `context_tokens`, `[limits]`) must be TOML integers: a float such as `1.0`
or `1e3` is `WRONG_TYPE`. An integer out of range is `UNSUPPORTED_VERSION`,
`INVALID_CAP`, `INVALID_LIMIT` or `INVALID_VALUE`, however many digits it has.
The file may be at most 64 KiB (`FILE_TOO_LARGE`) and 8 tables deep.

### Top level

| Key       | Type    | Required | Meaning                                          |
| --------- | ------- | -------- | ------------------------------------------------ |
| `version` | integer | yes      | Schema version; only `1` (`UNSUPPORTED_VERSION`) |

### `[node]`

| Key             | Type   | Meaning                                                                                                                                                        |
| --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`       | string | Required. `"devnet"`; `"mainnet"` is refused with `MAINNET_UNSUPPORTED`                                                                                        |
| `data_dir`      | string | Local home, same meaning as `GYBLOS_HOME`; relative paths resolve against the working directory. The seller refuses it (see [Seller startup](#seller-startup)) |
| `payout_wallet` | string | A Solana address, never the node key. The seller refuses it; the role file owns the payout                                                                     |
| `rpc_url`       | string | `https`, or `http` on loopback; no credentials or query. The seller refuses it; the role file owns the RPC                                                     |

### `[relays]`

| Key               | Type             | Meaning                                                                                                                       |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `urls`            | array of strings | 1 to 8 HTTPS origins without path, query or credentials; duplicates after normalization are refused (`DUPLICATE_VALUE`)       |
| `relay_token_env` | string           | Name of the variable that holds a relay token. The Gyblos relays need no token; set it only for an owned relay that needs one |

### `[transport]`

| Key             | Type    | Meaning                                                                |
| --------------- | ------- | ---------------------------------------------------------------------- |
| `relay_only`    | boolean | Seller accepts connections only through relays                         |
| `bind`          | string  | Local Iroh socket address, `ip:port` (IPv6 in brackets); port may be 0 |
| `external_addr` | string  | Advertised socket address, `ip:port`; port 1 or above                  |

Malformed `GYBLOS_IROH_BIND` or `GYBLOS_IROH_EXTERNAL_ADDR` values from the
environment fail when the endpoint binds, not when settings load.

### `[buyer]`

| Key          | Type    | Meaning                                                 |
| ------------ | ------- | ------------------------------------------------------- |
| `relay_only` | boolean | The local buyer connects to sellers only through relays |

### `[discovery]`

| Key       | Type    | Meaning                                                  |
| --------- | ------- | -------------------------------------------------------- |
| `publish` | boolean | Publish signed records to the discovery index            |
| `url`     | string  | Discovery index base URL; `https`, or `http` on loopback |

### `[telemetry]`

| Key    | Type    | Meaning                                                                       |
| ------ | ------- | ----------------------------------------------------------------------------- |
| `file` | boolean | Write private local telemetry to the role's file sink. File-only; default off |

The seller and the free local buyer read this key. It has no external
destination, and a programmatically injected sink takes precedence. See
[Telemetry](telemetry.md#file-telemetry-at-startup).

### `[diagnostics]`

| Key       | Type    | Default | Meaning                                                          |
| --------- | ------- | ------- | ---------------------------------------------------------------- |
| `enabled` | boolean | `true`  | Write operational diagnostics under `<home>/<role>/diagnostics/` |
| `level`   | string  | `warn`  | Minimum level: `debug`, `info`, `warn` or `error`                |

File-only; no environment variable overrides it. The local buyer applies these
settings; the seller accepts the section. See
[Operational diagnostics](diagnostics.md#configuration).

### `[limits]`

Seller capacity. See [Seller limits](#seller-limits).

### `[[offers]]`

At most 32 entries. Each model may appear once; aliases count as the same model.

| Key         | Required | Meaning                                                                                                                                                         |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`     | yes      | A catalog id or alias from `packages/protocol/src/models.ts` (for example `gpt-oss-20b`, `qwen3-30b-a3b`, `qwen3:0.6b`), or any identifier with `custom = true` |
| `custom`    | no       | `true` for a model outside the catalog. A catalog model with `custom = true` is `CUSTOM_MODEL_IN_CATALOG`; an unknown model without it is `UNKNOWN_MODEL`       |
| `engine`    | yes      | Engine table, below                                                                                                                                             |
| `reasoning` | no       | Non-empty list of distinct levels from `off`, `low`, `medium`, `high`; see [Reasoning levels](#reasoning-levels-per-model)                                      |
| `price`     | one of   | Paid offer, below                                                                                                                                               |
| `free`      | one of   | Free offer, below                                                                                                                                               |

An offer needs exactly one of `price` and `free` (`PRICING_MISSING`,
`PRICING_CONFLICT`).

#### `engine`

| Key              | Required                   | Meaning                                                                                                                                                                          |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`           | yes                        | `ollama`, `openai` or `anthropic`                                                                                                                                                |
| `url`            | yes                        | `https`; plain `http` only for `127.0.0.1`, `localhost`, `[::1]` or `host.docker.internal`. Each engine narrows this at startup ([Engine compatibility](#engine-compatibility))  |
| `api_key_env`    | no (`anthropic`: yes)      | Name of the variable holding the provider key, at most 128 characters                                                                                                            |
| `upstream_model` | no                         | The model name the engine expects, at most 256 characters; defaults to the offer's model. The validator does not check it                                                        |
| `context_tokens` | `openai`, `anthropic`: yes | Context size, 1,024 to 2,000,000, because remote APIs do not report it. On `ollama` it is optional and sets `num_ctx`, 1,024 to 32,768; the seller uses 8,192 when it is omitted |

A larger Ollama context uses more memory.

#### `price`

`price = { input_per_mtok, output_per_mtok, currency = "USDC" }`: USDC per
million tokens, as decimal strings.

- Trailing fractional zeros are dropped: `"0.10"`, `"1.50"` and `"2.0"` become
  `"0.1"`, `"1.5"` and `"2"`.
- A sign, exponent, leading zero (`"00.1"`) or empty part (`"1."`, `".5"`) is
  `NON_CANONICAL_DECIMAL`.
- More than 4 integer digits, or more than 6 decimals after dropping trailing
  zeros, is `PRICE_OUT_OF_RANGE`.
- Both sides zero is `PRICE_ZERO`.

Protocol v2 charges USDC atomic units (10^-6 USDC) per million tokens. Because a
price has at most 6 decimals, the conversion is exact.
`pricePerMtokToAtomicPerMtok` (from `@gyblos/node/node-config`) performs it:
`"0.1"` → `100000n`, `"1.5"` → `1500000n`, `"0.000001"` → `1n`.

#### `free`

`free = { daily_token_cap, per_buyer_cap, max_output_tokens }`:

| Key                 | Required | Meaning                                                                                             |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `daily_token_cap`   | yes      | Tokens the offer gives away per UTC day, across all buyers                                          |
| `per_buyer_cap`     | yes      | Tokens one buyer may use per day; not above `daily_token_cap` (`INVALID_CAP`)                       |
| `max_output_tokens` | no       | Longest answer one request may ask for; default 4,096, at most 32,768. Quotes beyond it are refused |

Caps are positive integers up to 10^12. The model's context also bounds an
answer, together with the conversation's tokens. A request carries a whole
conversation: an optional system message, then turns alternating user and
assistant, starting and ending with the user.

### Reasoning levels per model

`MODEL_CATALOG` in `packages/protocol/src/models.ts` declares the levels each
catalog model supports, from the closed set `off`, `low`, `medium`, `high`. A
model with only a thinking on/off switch uses `off` and `high`.

| Catalog id            | Levels                  | Default | Primary source                                                                                                                                                                                       |
| --------------------- | ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen3-30b-a3b`       | `off`, `high`           | `off`   | [Qwen3-30B-A3B model card](https://huggingface.co/Qwen/Qwen3-30B-A3B): `enable_thinking` switch                                                                                                      |
| `qwen3-235b-a22b`     | `off`, `high`           | `off`   | [Qwen3-235B-A22B model card](https://huggingface.co/Qwen/Qwen3-235B-A22B): same switch                                                                                                               |
| `qwen3-0.6b`          | `off`, `high`           | `off`   | [Qwen3-0.6B model card](https://huggingface.co/Qwen/Qwen3-0.6B): same switch                                                                                                                         |
| `gpt-oss-120b`        | `low`, `medium`, `high` | `low`   | [gpt-oss model card](https://cdn.openai.com/pdf/419b6906-9da6-406c-a19d-1bb078ac7637/oai_gpt-oss_model_card.pdf) and [harmony guide](https://developers.openai.com/cookbook/articles/openai-harmony) |
| `gpt-oss-20b`         | `low`, `medium`, `high` | `low`   | Same, and the [gpt-oss-20b model card](https://huggingface.co/openai/gpt-oss-20b)                                                                                                                    |
| `llama-3.3-70b`       | `off`                   | `off`   | [Llama-3.3-70B-Instruct model card](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct): no reasoning mode                                                                                     |
| `gemma-4-26b`         | `off`, `high`           | `off`   | [gemma-4-26B-A4B-it model card](https://huggingface.co/google/gemma-4-26B-A4B-it): `<\|think\|>` token turns thinking on or off                                                                      |
| `deepseek-v4.1-flash` | not verified            |         | [DeepSeek-V4.1-Flash model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash): effort is an integer from 1 to 100, no documented off                                                      |
| `kimi-k3`             | not verified            |         | [Kimi-K3 model card](https://huggingface.co/moonshotai/Kimi-K3): always thinking, `low`, `high` or `max`                                                                                             |
| `glm-5.3-flash`       | not verified            |         | [GLM-5.3-Flash model card](https://huggingface.co/zai-org/GLM-5.3-Flash): `low`, `high` or `max`, no documented off                                                                                  |

| Model in the offer                          | Listed `reasoning`                                                                      | Omitted `reasoning`     |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------- |
| Catalog model with verified levels          | Every level must be supported, else `REASONING_UNSUPPORTED` at `offers[i].reasoning[j]` | The model's default     |
| Custom model, or catalog model not verified | Any list from the closed set, with the warning `REASONING_UNVERIFIED`                   | `["off"]`, same warning |

Thinking tokens are not metered, so offer defaults keep thinking off where a
model allows it, although the Qwen3 cards default to thinking on. gpt-oss always
reasons; its vendor default is `medium`, and the offer default is `low`. "Not
verified" means the vendor's levels do not map one-to-one onto the closed set,
so the catalog holds `null` for them.

The catalog alias for Qwen3 30B is the hybrid `qwen3:30b-a3b-q4_K_M`. Ollama's
bare `qwen3:30b-a3b` tag points at a thinking-only build that cannot turn
thinking off, so it is not an alias: `model = "qwen3:30b-a3b"` fails with
`UNKNOWN_MODEL`. Use `model = "qwen3-30b-a3b"` and set
`upstream_model = "qwen3:30b-a3b-q4_K_M"`. Because the validator does not check
`upstream_model`, pointing it at the thinking-only tag would serve a model that
ignores `off`.

The JSON Schema checks only the closed set; the validator enforces the per-model
rule.

## Seller startup

`gyblos start` (`pnpm node:start` in a checkout) reads the file chosen by
[Which file is read](#which-file-is-read). Without a file, or without
`[[offers]]`, startup stops with `SELLER_OFFERS_MISSING`. Environment variables
still override the file's settings, and an invalid value stops startup with
`NODE_CONFIG_INVALID` before any engine warms up.

What the seller does with each part of the file:

| Setting                                         | Seller behavior                                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `[transport]`                                   | Used                                                                                                                                         |
| `[relays]`                                      | Used. The token stays in the named variable; relay errors still name `GYBLOS_RELAY_TOKEN`                                                    |
| `[discovery]`                                   | Used                                                                                                                                         |
| `[limits]`                                      | Used; see [Seller limits](#seller-limits)                                                                                                    |
| `[telemetry]`                                   | Used                                                                                                                                         |
| `[diagnostics]`                                 | Accepted                                                                                                                                     |
| `[[offers]]` with `free`                        | Served over the free channel with daily and per-buyer token caps                                                                             |
| `[[offers]]` with `price`                       | Sold on devnet over the paid stream; see [Paid offers](#paid-offers)                                                                         |
| `[node]` `data_dir`, `rpc_url`, `payout_wallet` | Refused with `SELLER_SETTING_UNSUPPORTED`: the role files own them. `GYBLOS_HOME` instead of `data_dir` is fine; `GYBLOS_RPC_URL` is ignored |
| `[buyer]`                                       | Ignored                                                                                                                                      |

The seller serves every `[[offers]]` entry, each through its engine plugin. One
entry its plugin cannot serve stops startup with that entry's code. Startup
warms the offers one at a time and starts as soon as one is ready. It warms the
others again every minute in the background. The signed catalog lists only the
offers that are ready: an offer leaves it while it renews or after a failed
check, and returns with its next good observation.

The daemon prints a startup refusal as one line with its code, the `[[offers]]`
entry it concerns and a hint. `gyblos seller status` shows the code until a
start succeeds.

### Engine compatibility

| Engine      | Allowed `url`                                                                                                     | Required keys                   | Usage counted by                                                   | Readiness check                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `ollama`    | `http://127.0.0.1:PORT/` or `http://[::1]:PORT/`, no path                                                         | none; no `api_key_env`          | The pinned public tokenizer                                        | Warmup generation and memory check                         |
| `openai`    | API base ending in its version: `https://...` on any host, or `http://127.0.0.1:PORT/v1` / `http://[::1]:PORT/v1` | `context_tokens`                | The pinned tokenizer for Qwen3 0.6B; the provider for other models | Loopback: warmup and memory check. Remote: lists the model |
| `anthropic` | API root without `/v1` (`https://api.anthropic.com`), or a literal loopback proxy                                 | `api_key_env`, `context_tokens` | The provider, input including cached prompt tokens                 | `GET /v1/models/{model}`, even on loopback                 |

Every engine refuses plain `http` to `localhost`, `host.docker.internal` or any
host other than a literal loopback address, and a URL with a query or fragment,
with `SELLER_OFFER_ENGINE_UNSUPPORTED`. A LAN server needs `https`. Every engine
serves reasoning `["off"]` only (`SELLER_OFFER_REASONING_UNSUPPORTED`
otherwise).

`ollama`:

- Serves the pinned Qwen3 0.6B (`qwen3-0.6b` or `qwen3:0.6b`). The pulled model
  must match the pinned digest, or warmup fails and the seller is not
  advertised.
- Runs on your own Ollama at the offer's URL; the seller never starts it. Run a
  dedicated one ([Seller](running-a-node.md#seller)).
- Keep Ollama on loopback only: no `OLLAMA_HOST=0.0.0.0` and no "Expose Ollama
  to the network" app setting. Ollama has no authentication, and the seller
  cannot detect the exposure.

`openai` (vLLM, LM Studio, llama.cpp, OpenRouter, OpenAI and other
OpenAI-compatible APIs):

- The key goes only in the `Authorization` header to that base URL. It never
  follows a redirect and is never written or printed.
- A remote API is ready once it lists the model, so readiness never spends the
  seller's credit.
- Turn reasoning off on the server, for example with a non-thinking chat
  template. An answer whose whole budget went to hidden reasoning is refused as
  invalid.
- OpenAI's own API (`api.openai.com` and its regional hosts) gets
  `max_completion_tokens`; other servers get `max_tokens`.

`anthropic` (the Anthropic Messages API or a compatible one):

- A URL with a `/v1` segment anywhere in its path is refused with
  `SELLER_OFFER_ENGINE_UNSUPPORTED`, and a dot-only model name with
  `SELLER_OFFER_MODEL_UNSUPPORTED`.
- The key goes only in the `x-api-key` header to that URL.
- A translating proxy that already folds cached tokens into `input_tokens` is
  counted twice.
- A `billing_error`, or a 400 whose message names the credit balance, is quota
  exhaustion; a 529 is unavailable.
- A compatible server must implement `POST /v1/messages` and
  `GET /v1/models/{model}`. Amazon Bedrock and Google Vertex work only behind a
  gateway that serves both.

For any engine, an `api_key_env` that names an unset or empty variable stops
startup with `SELLER_OFFER_API_KEY_MISSING`. One that names a `GYBLOS_*`
variable or the relay token's variable stops it with
`SELLER_OFFER_API_KEY_UNSAFE`.

### Paid offers

A paid offer is sold on devnet over reusable x402 batch-settlement channels.
Buyers pay the seller's price plus the protocol fee (`PROTOCOL_FEE` in
`@gyblos/config`, 4% on devnet), rounded up. Startup accepts a paid offer only
when:

- Usage is recounted with the model's pinned public tokenizer
  (`SELLER_PAID_METERING_UNRECOUNTED` otherwise). Only the catalog model
  `qwen3-0.6b` has one.
- The seller role was set up with a payout and payment keys
  (`SELLER_PAYMENT_ROLE_MISSING` otherwise), and the payout is neither the fee
  payer nor the authorizer key (`SELLER_PAYMENT_DESCRIPTION_INVALID`).
- The role's RPC serves devnet (`SELLER_PAYMENT_NETWORK_MISMATCH`).
- The payout, protocol fee treasury and fee payer token accounts exist or can be
  created (`SELLER_PAYMENT_ACCOUNTS_UNAVAILABLE`).

The fee payer needs devnet SOL to prepare the payout accounts and pay channel
transaction fees. See [payment sessions](payment-sessions.md).

### Startup codes

| Code                                  | Cause                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_CONFIG_INVALID`                 | The file or environment is invalid; run `gyblos config validate` for details                                                          |
| `SELLER_SETTING_UNSUPPORTED`          | The file sets `node.data_dir`, `node.rpc_url` or `node.payout_wallet`                                                                 |
| `SELLER_OFFERS_MISSING`               | No file, or no `[[offers]]`                                                                                                           |
| `SELLER_OFFER_MODEL_UNSUPPORTED`      | The engine cannot serve this model                                                                                                    |
| `SELLER_OFFER_ENGINE_UNSUPPORTED`     | The engine URL or kind is not allowed for this engine                                                                                 |
| `SELLER_OFFER_REASONING_UNSUPPORTED`  | A reasoning level other than `off`                                                                                                    |
| `SELLER_OFFER_API_KEY_MISSING`        | `api_key_env` is required, or names an unset or empty variable                                                                        |
| `SELLER_OFFER_API_KEY_UNSAFE`         | `api_key_env` names a `GYBLOS_*` variable or the relay token's variable                                                               |
| `SELLER_PAID_EXECUTION_UNAVAILABLE`   | A paid offer, but the caller wired no payment server (a library caller of `@gyblos/node`)                                             |
| `SELLER_PAID_METERING_UNRECOUNTED`    | A paid offer whose usage cannot be recounted with the pinned tokenizer                                                                |
| `SELLER_PAYMENT_ROLE_MISSING`         | A paid offer on a role without a payout and payment keys                                                                              |
| `SELLER_PAYMENT_DESCRIPTION_INVALID`  | The payout is the fee payer or authorizer key                                                                                         |
| `SELLER_PAYMENT_NETWORK_MISMATCH`     | The role's RPC is not devnet                                                                                                          |
| `SELLER_PAYMENT_ACCOUNTS_UNAVAILABLE` | A payout, treasury or fee payer token account is missing and could not be created, or is frozen                                       |
| `SELLER_RELAY_OFFLINE`                | After the file is accepted: no Gyblos relay answered within 30 s. Check internet access (HTTPS and UDP 7842) or a refused relay token |

## Seller limits

`[limits]` sets how much one seller accepts. Every key is optional; an omitted
key keeps the built-in value. Each value is an integer from 1 to a hard ceiling,
so a typo cannot let one seller exhaust its machine. A value out of range is
`INVALID_LIMIT`, and startup stops with `NODE_CONFIG_INVALID`.

| Key                          | Default | Ceiling | Meaning                                                                              |
| ---------------------------- | ------- | ------- | ------------------------------------------------------------------------------------ |
| `max_connections`            | 8       | 64      | Open buyer connections in total                                                      |
| `requests_per_minute`        | 30      | 120     | Requests per buyer NodeId per minute                                                 |
| `global_requests_per_minute` | 256     | 1024    | Requests per minute across all buyers                                                |
| `max_free_buyers_per_day`    | 1024    | 65536   | Distinct buyers served free per UTC day, across all free offers                      |
| `max_sessions`               | 16      | 16      | Open reusable payment sessions; see [payment sessions](payment-sessions.md#capacity) |

```toml
[limits]
max_connections = 16
requests_per_minute = 60
global_requests_per_minute = 1024
```

Each connected buyer reserves its `requests_per_minute` from the global budget,
so the budget must cover a full pool:
`max_connections × requests_per_minute ≤ global_requests_per_minute`, using the
default for any key the file omits (the defaults give 8 × 30 = 240 ≤ 256).
Otherwise later buyers would be refused and one buyer could hold the whole
budget. The file is then refused with `INVALID_LIMIT` on the first key it sets
among `global_requests_per_minute`, `requests_per_minute` and `max_connections`.
The editor schema cannot check this rule; `config validate` does.

Only executions count as requests. Control queries before one (catalog,
presence, quote) and receipt calls after it do not count against this budget or
hold a generation slot. Their own per-buyer admission bounds them: 5 per second
and 4 at a time. So 30 per minute means 30 answers per buyer.

A free request costs up to four connections (control, execution, one or two
receipt calls), and each is attempted twice before its handshake (QUIC address
validation). So the connection-attempt limits are four times the request rate
per buyer (120 by default) and eight times before the handshake (256 per source
and 2048 in total by default). They rise with a raised rate and never fall below
their built-in values. Up to 8 handshakes are pending at once, whatever
`max_connections` is, so a large pool fills gradually.

Fixed values, not configurable:

- The seller runs one generation at a time. Each buyer has one request in
  flight, and the seller at most two (one running, one queued; one for a free
  offer).
- Each buyer keeps one control and one data connection.
- Wire sizes and deadlines protect the protocol, not capacity.

`[limits]` is file-only: no `GYBLOS_*` variable sets it, and the buyer ignores
it. `gyblos doctor` prints the limits the seller will serve with.

## Seller preflight (`gyblos doctor`)

```sh
pnpm gyblos doctor                         # reads the file gyblos start reads
GYBLOS_CONFIG=my.toml pnpm gyblos doctor   # the file gyblos start will read with this variable
pnpm gyblos doctor --online                # also calls remote engine APIs, checks payment accounts and the clock
```

`doctor` has no `--config` flag: it reads exactly the file `gyblos start` reads,
so a passing doctor and a starting seller never look at different files. It
runs, read-only, the checks startup would fail on, and prints one line per check
(`OK`, `WARN` or `FAIL`) with a static code and a hint:

| Check       | What it verifies                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`    | The file and environment as seller startup reads them, with the same [startup codes](#startup-codes); file problems are listed with their key paths                                                                                                                                                                                                                |
| `home`      | No legacy `.local` layout under the role or tokenizer directories                                                                                                                                                                                                                                                                                                  |
| `role`      | The seller `role.json` exists and is valid (`ROLE_MISSING` hints `node:setup`)                                                                                                                                                                                                                                                                                     |
| `keys`      | The owner and node key files are regular, non-symlinked files owned by you with mode 0600. Metadata only, so a corrupt key is found only at startup                                                                                                                                                                                                                |
| `sequence`  | The seller directory is mode 0700 and its public-sequence file is valid for this node. A leftover sequence lock fails, because it blocks every publication; inspect it, never delete it blindly                                                                                                                                                                    |
| `tokenizer` | The pinned tokenizer files are present and match their hashes (`TOKENIZER_UNAVAILABLE` hints `node:tokenizer`); `NOT_NEEDED` when every offer's usage is declared by its provider                                                                                                                                                                                  |
| `engine[N]` | One line per `[[offers]]` entry N, counted from 1: the engine answers at its URL with its model, without generating. Fails only when no offer's engine answers; otherwise warns (`ENGINE_UNAVAILABLE`, `ENGINE_TIMEOUT`). A remote API is called only with `--online`, because the call carries its API key; without it the line warns `REMOTE_ENGINE_NOT_CHECKED` |
| `relays`    | Relay URLs and token as the endpoint would build them; the token is never printed                                                                                                                                                                                                                                                                                  |
| `payments`  | Only with a paid offer: the payout and payment keys, as startup checks them. With `--online`, also that the role's RPC serves devnet and the token accounts: warns `PAYMENT_ACCOUNTS_MISSING` (startup creates them) or `PAYMENT_ACCOUNTS_UNCHECKED` (no answer), fails `PAYMENT_ACCOUNTS_UNUSABLE` (frozen or not a token account)                                |
| `clock`     | Only with `--online` and publication on: this clock against the discovery index's HTTP `Date` header. `CLOCK_SKEWED` warns when it is over 2 s off; buyers and the index refuse records issued over 5 s ahead, so turn on automatic time sync (NTP). `CLOCK_UNCHECKED` when the index gives no time or answers in over 1 s                                         |

It then prints the seller's public **NodeId and owner** address from
`role.json`, and the effective [seller limits](#seller-limits). The exit code is
0 when no check fails (warnings do not fail) and 1 otherwise.

`doctor` starts, spawns, sends and writes nothing. It never prints the home
location, the RPC URL, the relay token, an API key or key material. It reaches
only each offer's loopback engine URL, plus, with `--online`, each remote
engine's model list, the role's RPC and the discovery index origin. Memory
headroom, key contents and the NodeId matching `node.key` are checked at startup
only.

## Issue codes

Errors (`NODE_CONFIG_ISSUE_CODES` in `packages/node/src/constants.ts`):
`TOML_SYNTAX`, `FILE_NOT_FOUND`, `FILE_UNREADABLE`, `FILE_TOO_LARGE`,
`UNKNOWN_KEY`, `MISSING_KEY`, `WRONG_TYPE`, `INVALID_VALUE`,
`UNSUPPORTED_VERSION`, `MAINNET_UNSUPPORTED`, `INVALID_ADDRESS`, `INVALID_URL`,
`INSECURE_URL`, `INVALID_ENV_NAME`, `INLINE_SECRET`, `DUPLICATE_VALUE`,
`TOO_MANY`, `UNKNOWN_MODEL`, `CUSTOM_MODEL_IN_CATALOG`, `NON_CANONICAL_DECIMAL`,
`PRICE_OUT_OF_RANGE`, `PRICE_ZERO`, `PRICING_CONFLICT`, `PRICING_MISSING`,
`INVALID_CAP`, `RELAY_ONLY_CONFLICT`, `INVALID_LIMIT`, `REASONING_UNSUPPORTED`.

Warnings (`NODE_CONFIG_WARNING_CODES`): `ENV_SWITCH_NOT_STRICT` (a switch
variable other than `1` or `0`) and `REASONING_UNVERIFIED` (an offer whose
levels cannot be checked against the catalog).

## Editor support and examples

The JSON Schema is
[packages/node/schemas/gyblos.schema.json](../packages/node/schemas/gyblos.schema.json)
(draft-07). The examples start with a `#:schema` comment, which TOML editors
based on Taplo (such as Even Better TOML) use for completion and inline errors.
The schema cannot express a few cross-field rules: a per-buyer cap above the
daily cap, a model offered twice through an alias, relays that are equal after
normalization, the request budget in `[limits]` and the reasoning levels a
catalog model supports. `gyblos config validate` is authoritative.

Every example is valid. Their `#:schema` line is relative to this repository; in
a copy elsewhere, update or delete it.

| File                                                                    | Shows                                                       | Starts the seller as written |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------- |
| [examples/seller-daemon.toml](../examples/seller-daemon.toml)           | One free Qwen3 0.6B offer on a dedicated loopback Ollama    | yes                          |
| [examples/seller-docker.toml](../examples/seller-docker.toml)           | The same in Docker (`compose.yaml`)                         | yes                          |
| [examples/openai-free.toml](../examples/openai-free.toml)               | A free offer from any OpenAI-compatible API                 | yes                          |
| [examples/anthropic-free.toml](../examples/anthropic-free.toml)         | A free offer from the Anthropic API                         | yes                          |
| [examples/ollama-local.toml](../examples/ollama-local.toml)             | One model from an Ollama on this machine                    | no                           |
| [examples/lm-studio.toml](../examples/lm-studio.toml)                   | LM Studio's OpenAI-compatible server, gpt-oss effort levels | no                           |
| [examples/openai-reseller.toml](../examples/openai-reseller.toml)       | Reselling an OpenAI-compatible API with `api_key_env`       | no                           |
| [examples/anthropic-reseller.toml](../examples/anthropic-reseller.toml) | An Anthropic-compatible API and a custom model              | no                           |
| [examples/free-offer.toml](../examples/free-offer.toml)                 | A free offer with caps, Docker host engine, publication off | no                           |
| [examples/multi-model.toml](../examples/multi-model.toml)               | Several models on one node                                  | no                           |

The examples marked "no" are valid files that the seller refuses at startup:
they set `[node]` keys the role files own (`SELLER_SETTING_UNSUPPORTED`) or list
reasoning levels other than `off` (`SELLER_OFFER_REASONING_UNSUPPORTED`). The
custom models in `anthropic-free.toml` and `anthropic-reseller.toml` validate
with the `REASONING_UNVERIFIED` warning.

## Library entry points

- `@gyblos/node/node-config`: `parseNodeConfig`, `validateNodeConfig`,
  `readNodeConfigFile`, `pricePerMtokToAtomicPerMtok` and the `NodeConfig` type;
  a valid result also carries `warnings`.
- `@gyblos/node/node-config-file`: `nodeConfigPath` and `readStartupConfig`, the
  one rule for which file is read.
- `@gyblos/node/node-config-resolve`: `resolveNodeConfig({ file, env, flags })`,
  which returns settings, origins, secret references and warnings, or issues.
