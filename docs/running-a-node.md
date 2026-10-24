# Running a seller and a buyer

A seller node serves paid inference over Iroh. A buyer proxy on another machine
forwards local requests to it. Both are devnet-only and experimental.

## Local home

All node data lives under one local home, `GYBLOS_HOME` (default `.local/gyblos`
in the working directory; a container image would use `/data`). Each role has
its own directory, so one machine can hold a buyer and a seller side by side
without sharing keys or journals:

| Path                              | Contents                                                      |
| --------------------------------- | ------------------------------------------------------------- |
| `<home>/buyer/`                   | Buyer keys, role, trust, offer copy, journals, lock, calls.   |
| `<home>/seller/`                  | Seller keys, role, signed offer, status, traces, diagnostics. |
| `<home>/artifacts/tokenizer/`     | Pinned public tokenizer (re-downloadable).                    |
| `<home>/artifacts/ollama-models/` | Pinned Ollama model layers (re-downloadable).                 |

Lab state (`gate:*`, identity tools) lives in a separate `GYBLOS_LAB_HOME`
(default `.local/lab`). The lab shares `<home>/artifacts/` as a public cache
(`gate:inference:setup` may write the tokenizer and model there) but never reads
or writes a role directory.

Keep a custom `GYBLOS_HOME` or `GYBLOS_LAB_HOME` outside the repository or under
`.local/`; only `.local/` is ignored by git.

### Moving data from the old layout

Older versions kept role data in `.local/p2p/` (one role per checkout), the
tokenizer in `.local/devnet/tokenizer/`, models in `.local/ollama/models/` and
lab state in `.local/devnet/`. Nothing is migrated automatically. When a home
directory is missing but its old path exists, setup and startup stop with
`LEGACY_LOCAL_LAYOUT`, naming both paths. For the lab the test is lab state, not
the directory: an empty or lock-only `.local/lab` does not count, so every lab
command keeps refusing until the old lab files are moved. A fresh role next to
an old, possibly uncertain authorization journal could otherwise lose recovery
state ([recovery.md](recovery.md)). The check only tests whether the old path
exists (it never reads it) and applies whether or not `GYBLOS_HOME` is set,
because an old journal in the working directory is just as unsafe to ignore when
the new home is elsewhere.

Before you move anything:

- Stop every node, buyer and lab (`gate:*`) process.
- Never merge into an existing destination: `mv` would put the old directory
  inside it, hiding its journal one level down. If a destination already exists,
  stop and compare the two directories by hand. An empty one can be removed with
  `rmdir`, which refuses a non-empty directory.
- Run the commands from the same working directory. `ls .local/p2p` shows
  `buyer.json` for a buyer or `owner.json` for a seller.

Run this block after choosing the role destination (`buyer` below, or `seller`).
It uses `GYBLOS_HOME` and `GYBLOS_LAB_HOME` when set, stops on the first
failure, and runs in a subshell so failure does not close your terminal.
Existing destinations, including dangling symlinks, are refused. Omit moves
whose source never existed.

The lab config records absolute key paths. After moving it, the block rewrites
only keys directly inside the old lab directory to the actual new directory. It
preserves the original config exclusively as `config.json.bak` and stages the
replacement before renaming it. Unexpected key paths require manual review; no
keys or journals are read or rewritten.

```sh
(
  umask 077
  product_home=${GYBLOS_HOME:-.local/gyblos}
  lab_home=${GYBLOS_LAB_HOME:-.local/lab}
  move() {
    if [ -e "$2" ] || [ -L "$2" ]; then
      echo "stop: destination exists; compare by hand" >&2
      return 1
    fi
    mkdir -p "$(dirname "$2")" && mv "$1" "$2"
  }
  move .local/p2p "$product_home/buyer" || exit 1  # seller checkout: use seller
  move .local/devnet/tokenizer "$product_home/artifacts/tokenizer" || exit 1
  move .local/ollama/models "$product_home/artifacts/ollama-models" || exit 1
  move .local/devnet "$lab_home" || exit 1
  node --input-type=module - "$lab_home/config.json" <<'NODE' || exit 1
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
try {
  const file = resolve(process.argv[2]);
  const original = readFileSync(file, 'utf8');
  const config = JSON.parse(original);
  for (const [role, path] of Object.entries(config.keys)) {
    if (typeof path !== 'string' || !isAbsolute(path) ||
        dirname(path) !== resolve('.local/devnet')) throw new Error();
    config.keys[role] = resolve(dirname(file), basename(path));
  }
  writeFileSync(file + '.bak', original, { flag: 'wx', mode: 0o600 });
  writeFileSync(file + '.migrating', JSON.stringify(config, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  renameSync(file + '.migrating', file);
} catch {
  console.error('stop: review the moved config and any backup manually');
  process.exitCode = 1;
}
NODE
  if [ -e .local/identity/keys ] || [ -L .local/identity/keys ]; then
    move .local/identity/keys "$lab_home/identity/keys" || exit 1
  fi
)
```

Review the moved `config.json` and its key paths before restarting anything,
then delete `config.json.bak`: the old copy may hold an RPC URL with an API key.
After any failure, inspect the source and destination and resume only the
remaining moves; do not repeat the whole block blindly. An incomplete config
rewrite leaves the moved config and original backup for manual recovery.
`.local/identity-validator/` is disposable test scratch and is not checked.

## Roles and files

`pnpm node:setup --role` creates the role directory, the role file, the Iroh
node key (`node.key`) and the role's Solana keys with private permissions. It
never overwrites existing keys; a mismatched existing role stops with an error.

| File                                             | Role  | Contents                                                |
| ------------------------------------------------ | ----- | ------------------------------------------------------- |
| `role.json`                                      | both  | Role, mint, NodeId and public addresses.                |
| `node.key`                                       | both  | Iroh secret key (private).                              |
| `*.json` keys                                    | both  | Buyer key, or seller owner/authorizer/facilitator keys. |
| `offer.json`                                     | both  | Seller writes its signed offer; buyer reads a copy.     |
| `trust.json`                                     | buyer | Which seller and limits the buyer accepts.              |
| `status.json`                                    | both  | `starting` with a phase, then `ready`.                  |
| `authorization.json`, `calls.json`, `buyer.lock` | buyer | Payment journal, call history, lock.                    |

## Seller

```sh
export GYBLOS_RELAY_TOKEN=...    # private; 32-512 printable characters
pnpm node:setup --role seller --mint MINT --buyer BUYER_ADDRESS --pay-to PAYOUT_ADDRESS
pnpm gate:inference:setup        # pinned Qwen3 0.6B model and tokenizer (lab command for now)
pnpm node:start
```

- `--buyer` is the one buyer address this seller accepts; `--pay-to` is a cold
  payout address (it must not be one of the seller's hot keys).
- Fund the seller's `facilitator` address (printed by setup) with devnet SOL; it
  pays transaction fees and channel rent.
- Startup checks devnet, starts a private Ollama on port 11436 and a facilitator
  on 4022 (both loopback), checks memory headroom, runs one private warmup and
  only then signs the offer. The offer expires four minutes after warmup;
  restart the node to publish a fresh one.
- The paid HTTP bridge exposes only `/v1/chat/completions`. A separate
  `gyblos/control/1` ALPN serves signed catalog, presence and quote queries.
  Stop with Ctrl-C.

## Buyer

```sh
export GYBLOS_RELAY_TOKEN=...
pnpm node:setup --role buyer --mint MINT
pnpm buyer:setup             # download and verify only the pinned tokenizer
# copy the seller's .local/gyblos/seller/offer.json into .local/gyblos/buyer/
pnpm buyer:trust --owner SELLER_OWNER_ADDRESS --node-id SELLER_NODE_ID --pay-to PAYOUT_ADDRESS --max-atomic 10000
pnpm buyer:start
```

Independently confirm the seller owner, NodeId and payout address before running
`buyer:trust`. The command checks the offer signature, lifetime, payment terms
and configured relay against those explicit identities and the local buyer/mint.
It creates private `trust.json` exclusively and refuses to overwrite an existing
file. It does not derive trust automatically from the offer or make payments.

`trust.json` names the seller you trust; every field must match the offer:

```json
{
  "owner": "SELLER_OWNER_ADDRESS",
  "nodeId": "SELLER_NODE_ID",
  "mint": "MINT",
  "payTo": "PAYOUT_ADDRESS",
  "buyer": "BUYER_ADDRESS",
  "maxAtomic": "10000"
}
```

`buyer:setup` downloads public tokenizer files into
`.local/gyblos/artifacts/tokenizer/`. It does not install Ollama, download model
weights, read keys or contact Solana. Run it once before the synthetic paid-call
CLI.

There is no command that funds P2P roles. Give the buyer address test tokens of
`MINT` with your own Solana tooling.

The proxy listens on `127.0.0.1:4031` and accepts only
`POST /v1/chat/completions` with a loopback `Host`. It runs one request at a
time; a second waits and a third gets 429. Malformed JSON gets 400
`MALFORMED_JSON`. A transport failure returns 503 and is treated as an uncertain
payment, never retried.

One paid synthetic call through a running proxy: `pnpm buyer:call 0` (case 0, 1
or 2). It records journals and measurements in `.local/gyblos/buyer/`.

## Control queries

The seller exposes `catalog.get`, `presence.get` and `offer.request` over a
separate control ALPN. A query never runs inference, takes a payment or reserves
capacity. Startup still performs its normal warmup. The catalog currently lists
the pinned model with reasoning `off`; unsupported levels and busy state are
refused. Catalog/readiness validity ends at the existing warmup deadline.

The programmatic `@gyblos/buyer/control` client connects to one chosen seller
using a caller-owned Iroh endpoint and independently confirmed owner/NodeId and
relay policy. Its `getCatalog`, `getPresence` and `requestOffer` methods verify
request correlation, signatures and exact quote terms. It does not choose a
seller or change proxy behavior. Call `close()` when finished; the endpoint
remains owned by the caller. There is no control CLI yet.

Quotes are `offer/v2` and are rejected by the current paid flow. They indicate
observed availability, not guaranteed admission. Both clocks must be
synchronized: v2 retains zero clock-skew tolerance and no expiration grace.
Queries have a 10-second absolute deadline and share endpoint admission before
their separate control quotas. See
[the protocol specification](../packages/protocol/SPEC.md).

## Relays

- Default relay: `https://na1.relay.gyblos.com/` (QUIC address discovery on UDP
  7842). Public n0 relays are not used as a fallback.
- `GYBLOS_RELAY_TOKEN` is required by both roles. There is no built-in token; a
  missing or invalid token stops endpoint binding. It is sent only to the owned
  hosts `na1.relay.gyblos.com` and `na2.relay.gyblos.com`. Never put it in a
  relay URL, an offer, a config file or a committed env file.
- `GYBLOS_RELAYS` overrides the relay list (comma-separated HTTPS origins). Both
  roles must use the same list. The buyer accepts an offer's relay only if it is
  in that list. To add `na2` once it exists:
  `GYBLOS_RELAYS=https://na1.relay.gyblos.com/,https://na2.relay.gyblos.com/`.
- Iroh prefers a direct path and falls back to the relay. That does not retry a
  paid request.

## Relay-only and privacy

A direct connection shows each peer's IP address to the other.

- `GYBLOS_RELAY_ONLY=1` (seller): binds loopback only, advertises no direct
  addresses and rejects an observed direct path.
- `GYBLOS_BUYER_RELAY_ONLY=1` (buyer): binds loopback only, ignores
  `GYBLOS_IROH_BIND` and the seller's direct addresses, and dials only the
  offer's configured relay. An offer without a relay is rejected.
- `GYBLOS_EXPECTED_ROUTE=iroh-direct|iroh-relay` (buyer) refuses to pay when the
  observed route differs. Requiring a relay route alone does not hide the
  buyer's address; use `GYBLOS_BUYER_RELAY_ONLY=1` for that.
- `GYBLOS_IROH_BIND` sets the UDP bind address; `GYBLOS_IROH_EXTERNAL_ADDR` adds
  a public address to advertise (rejected in relay-only mode).

The relay still sees both peers' IP addresses. Off-host relay-only privacy has
not been measured.

## Other settings

- `GYBLOS_HOME`: local home for both roles and shared artifacts (default
  `.local/gyblos`).
- `GYBLOS_RPC_URL`: devnet RPC; the genesis hash is checked before use.
- `GYBLOS_P2P_RUN_ID`: optional label copied into `status.json` and evidence.
- Ports: buyer proxy 4031, seller HTTP 4032 (loopback only), facilitator 4022,
  Ollama 11436. Stop any lab runs (`gate:*`) before starting a seller.

Facilitator diagnostics for the seller are written privately under
`.local/gyblos/seller/facilitator-diagnostics/`; see [payments.md](payments.md).

Local role/trust JSON is validated before use: required fields, Solana
addresses, lowercase hex NodeIds, HTTP(S) RPC URLs and positive decimal-string
budgets up to the local maximum. Existing malformed configurations now fail
explicitly. Operator RPC URLs may contain provider credentials; validation
errors never echo them.

Role and trust files reject unknown fields. Trust budgets must be canonical
positive decimal strings (`"10"`, not `"0010"`). Files produced by `node:setup`
and trust files with canonical budgets remain valid. Older `buyer:trust`
versions accepted leading-zero budgets; remove those leading zeros before
loading such a file. Validation errors do not echo field names or values.

### Optional buyer selection and discovery

A buyer may opt into local selection by placing `selection.json` in its buyer
home (`homeLayout`: `$GYBLOS_HOME/buyer`, default `.local/gyblos/buyer`).
Without this file, the existing trusted v1 proxy path is unchanged. The file
contains:

- `request`: `selection` (`modelId`, nullable `variant` and `quantization`),
  exact `reasoning`, nullable `lowestReasoning`, `network`, `asset`,
  `maxTokens`, canonical decimal `maxAtomic`, `priceCeilings` (`inputAtomic`,
  `outputAtomic`), `minimumBadge: "declared-usage"`, and an accepted `retention`
  array;
- `sellers`: at most 16 operator-trusted
  `{ owner, nodeId, relayUrl, directAddresses }` entries; an optional signed
  `withdrawal` is checked against the exact catalog. These identity bindings
  must come from an independent source, never the seller's own declaration.
  Relay origins must be configured;
- optional `pinnedNodeId` for “choose myself”. A pinned seller still passes all
  filters; `PINNED_SELLER_IN_COOLDOWN` includes `cooldownUntil` for the UI.

Without a `discovery` option this is a static candidate list. With optional
`"discovery": {}` (or
`{ "baseUrl": "https://your-index.example/v1", "maxPages": 3 }`), the HTTP index
supplies availability hints filtered by these independent identity/endpoint
bindings. Unknown identities are never enrolled. See
[discovery.md](discovery.md#buyer-runtime-integration) for durable replay state,
pagination, cache lifetime and failure behavior. Every badge is `declared-usage`
until a real checkability source exists; a catalog cannot elevate it.
`openChannel` is always false until payment channel reuse exists.

The buyer verifies catalog, presence and withdrawal signatures and bindings,
selects candidates, then requests signed quotes in parallel without the prompt.
Snapshots have a 10-second collection budget; a timed-out peer does not discard
healthy snapshots. The quote window is 300 ms, a proposed initial value rather
than measured production performance. A downgrade cannot win while an exact
candidate is pending, including at window expiry. Quotes reserve no capacity.
Idle HTTP connections are retired before control queries so the shared transport
admission still applies. Control connections close before v1 HTTP forwarding.

A different seller returns `SELECTED_SELLER_NOT_TRUSTED` (HTTP 409), with no
inference forwarding or payment. The trusted seller can proceed only through its
unchanged stored v1 offer. Quotes are never converted into v1. Because v1 has no
reasoning selection or separate selection-budget enforcement, execution requires
`off` reasoning, matching engine description/payment identities/prices/metering,
and the same maximum budget as the stored v1 offer. Other terms return
`QUOTE_REQUIRES_UNSUPPORTED_V2_EXECUTION`. Free v2 execution remains disabled.

The signed follow-up must match the original request ID and exact body bytes; no
new selection occurs after a payment header appears. A lost authorized response
blocks further routing until the existing reconciliation workflow has resolved
the uncertainty. Restarting the proxy is not reconciliation; the existing call
journal checks remain authoritative. The in-memory session admits at most 1,024
decisions, retaining authorized IDs to prevent replay until restart.

`selection-stats.json` stores only local quote successes/failures, latency,
cooldown and nullable wait metadata, via staged replacement with file mode 0600
and buyer-directory mode 0700. Quote latency is not inference latency; v2 quotes
provide no predicted wait, so quoted/observed wait and accuracy remain null
until an actual observation source exists. No prompts, offers or payment
payloads are stored there. No payments v2 are enabled.
