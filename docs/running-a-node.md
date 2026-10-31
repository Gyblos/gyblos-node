# Running a seller and a buyer

A seller node serves paid inference over Iroh. A buyer proxy on another machine
forwards local requests to it. Both are devnet-only and experimental.

## Local home

All node data lives under one local home, `GYBLOS_HOME` (default `.local/gyblos`
in the working directory; a container image would use `/data`). Each role has
its own directory, so one machine can hold a buyer and a seller side by side
without sharing keys or journals:

| Path                              | Contents                                                    |
| --------------------------------- | ----------------------------------------------------------- |
| `<home>/buyer/`                   | Buyer keys, role, trust, offer copy, journals, lock, calls. |
| `<home>/seller/`                  | Seller keys, role, status, readiness, public sequence.      |
| `<home>/artifacts/tokenizer/`     | Pinned public tokenizer (re-downloadable).                  |
| `<home>/artifacts/ollama-models/` | Lab-only cache of the pinned model for the `gate:*` Ollama. |

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
A seller needs only `--mint`: it gets an owner key and a node key. The paid
seller keys (authorizer and facilitator) and fields (`payTo`, allowed `buyer`)
are created only when `--buyer` and `--pay-to` are given together. A seller with
a paid `[[offers]]` entry needs them: paid v2 selling uses the payout and both
keys, and `--buyer` can be any address you control (v2 does not use it). Free
sellers leave both out.

| File                                             | Role   | Contents                                                                                                               |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `role.json`                                      | both   | Role, mint, NodeId and public addresses.                                                                               |
| `node.key`                                       | both   | Iroh secret key (private).                                                                                             |
| `*.json` keys                                    | both   | Buyer key, or seller owner key (paid keys only with `--buyer`/`--pay-to`).                                             |
| `offer.json`                                     | buyer  | A paid v1 seller's signed offer (lab gates only).                                                                      |
| `trust.json`                                     | buyer  | Which seller and limits the buyer accepts.                                                                             |
| `status.json`                                    | both   | `starting` with a phase, then `ready`; a seller lists each offer's index, model, engine kind and whether it is listed. |
| `engine-readiness.json`                          | seller | Each offer's latest private warmup outcome, by index.                                                                  |
| `authorization.json`, `calls.json`, `buyer.lock` | buyer  | Payment journal, call history, lock.                                                                                   |

## Seller

```sh
export GYBLOS_RELAY_TOKEN=...    # private; 32-512 printable characters
pnpm node:setup --role seller --mint MINT
pnpm node:tokenizer              # pinned tokenizer; doctor reports NOT_NEEDED when every offer's usage is declared
# A dedicated Ollama, used only for selling, on loopback; leave it running in its own terminal:
OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MODELS=$HOME/.gyblos-ollama OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 ollama serve
OLLAMA_HOST=127.0.0.1:11435 ollama pull qwen3:0.6b   # the pinned model
cp examples/seller-daemon.toml gyblos.toml   # one free offer at http://127.0.0.1:11435/; edit the caps
pnpm gyblos doctor               # read-only preflight; prints the public NodeId and owner
pnpm node:start
```

- The seller serves every free offer in `gyblos.toml`; without one it does not
  start (`SELLER_OFFERS_MISSING`). A paid offer is sold on devnet over the paid
  stream when the seller role was set up with a payout
  (`pnpm node:setup --role seller --mint <mint> --pay-to <payout> --buyer <address>`
  in a new `GYBLOS_HOME`; `--buyer` is still required by the v1 setup). The fee
  payer key needs devnet SOL for transaction fees and channel rent. Paid v2 has
  not settled on devnet yet; the v1 paid path remains in the lab gates only.
- The seller runs its own Ollama; the daemon never starts it. Startup warms each
  offer in order at its own engine URL (a literal loopback address), checking
  memory headroom for engines on this machine, and signs its public records once
  one offer is ready; the others are warmed again in the background and listed
  when they are ready.
- Use a dedicated Ollama for selling, with its own models directory
  (`OLLAMA_MODELS`) so the Ollama app cannot remove or replace the model. A
  shared one (the Ollama app, or other tools using the same instance) can evict
  the pinned model or slow it down, which shows up to buyers as `ENGINE_TIMEOUT`
  or a withdrawn offer. Never expose it to the network (`OLLAMA_HOST=0.0.0.0` or
  the app's "Expose Ollama to the network" setting): Ollama has no
  authentication, and anyone who can reach it could replace or delete the model.
  The seller trusts whatever answers on the offer URL, so run it on a machine
  where only you can bind local ports.
- `gyblos doctor` reports `ENGINE_UNAVAILABLE` both when Ollama is stopped and
  when the pulled model's digest differs from the pinned one; `ollama list` must
  show ID `7df6b6e09427` for `qwen3:0.6b`.
- The `gyblos/control/1` ALPN serves signed catalog, presence and quote queries;
  the free channels serve execution. Stop with Ctrl-C (not Ctrl-Z, which only
  suspends the process). Stopping withdraws from discovery and saves the public
  sequence; further Ctrl-C presses during that stop are ignored with a notice
  (SIGTERM from a supervisor too), so wait for the prompt. If a stop ever hangs,
  Ctrl-\\ (SIGQUIT) still ends the process, but can interrupt withdrawal or a
  state write and leave a sequence lock. A hung write or sync may itself be why
  shutdown has stalled; the order of cleanup does not make forced termination
  safe. A Ctrl-C during startup, a crash or `kill -9` can also leave a lock. Use
  `pnpm gyblos doctor` and the guarded
  [sequence recovery procedure](discovery.md#seller-duties); never reset the
  persisted sequence high-water mark.

## Buyer

Free inference uses `pnpm buyer:free`
([Free v2 buyer endpoint](#free-v2-buyer-endpoint)); `pnpm buyer` serves the
same endpoint and pays on devnet when `selection.json` sets a deposit ceiling
([Paid v2 buyer endpoint](#paid-v2-buyer-endpoint)). The paid v1 flow below
needs a paid seller's `offer.json`; the seller daemon never writes one, so the
v1 flow runs only against the lab gates (`gate:*`).

```sh
export GYBLOS_RELAY_TOKEN=...
pnpm node:setup --role buyer --mint MINT
pnpm node:tokenizer          # download and verify only the pinned tokenizer (`buyer:setup` is the same)
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

`node:tokenizer` (or `buyer:setup`) downloads public tokenizer files into
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
refused. A separate background lifecycle renews v2 availability through bounded
private warmup and memory checks; queries never trigger them. Failed/expired
checks and busy inference block availability; recovery produces a higher
catalog. The existing paid v1 offer and its original expiry are not renewed. See
[discovery.md](discovery.md#seller-duties) for timing and cancellation limits.

The programmatic `@gyblos/buyer/control` client connects to one chosen seller
using a caller-owned Iroh endpoint and independently confirmed owner/NodeId and
relay policy. Its `getCatalog`, `getPresence` and `requestOffer` methods verify
request correlation, signatures and exact quote terms. It does not choose a
seller or change proxy behavior. Call `close()` when finished; the endpoint
remains owned by the caller. There is no control CLI yet.

Quotes are `offer/v2` and are rejected by the legacy paid v1 flow. They indicate
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
  addresses and rejects an observed non-loopback direct path.
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

A relay-only seller can be tested with its buyer on the same machine. After the
first exchange Iroh may switch to a direct loopback path; relay-only accepts a
direct path only when its remote address is loopback (`127.0.0.0/8`, `::1` or
`::ffff:127.x.y.z`). A relay-only endpoint binds only loopback, so that path
reveals no address, and any other direct path is still refused. A local UDP
forwarder listening on loopback (a tunnel or proxy) would also look like
loopback, so do not run one on a relay-only machine.

## Other settings

These variables can also be written in a `gyblos.toml` file, checked with
`pnpm gyblos config validate`; the variables keep precedence over the file. See
[configuration.md](configuration.md). The seller reads `GYBLOS_CONFIG` or
`./gyblos.toml` at startup; see its "Seller startup" section for what it honors.

- `GYBLOS_HOME`: local home for both roles and shared artifacts (default
  `.local/gyblos`).
- `GYBLOS_RPC_URL`: devnet RPC; the genesis hash is checked before use.
- `GYBLOS_P2P_RUN_ID`: optional label copied into `status.json` and evidence.
- Ports: buyer proxy 4031 and the seller's Ollama at its offer URL (loopback
  only). The lab gates run their own Ollama on 11436 and the paid gates also use
  4032 and 4022.

Facilitator diagnostics are written only by the lab's paid gates; see
[payments.md](payments.md).

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
  `maxTokens`, canonical decimal `maxAtomic`, `priceCeilings`
  (`inputAtomicPerMtok`, `outputAtomicPerMtok`, atomic units per million
  tokens), `minimumBadge: "declared-usage"`, and an accepted `retention` array;
- `sellers`: at most 16 operator-trusted
  `{ owner, nodeId, relayUrl, directAddresses }` entries; an optional signed
  `withdrawal` is checked against the exact catalog. These identity bindings
  must come from an independent source, never the seller's own declaration.
  Relay origins must be configured;
- optional `pinnedNodeId` for “choose myself”. A pinned seller still passes all
  filters; `PINNED_SELLER_IN_COOLDOWN` includes `cooldownUntil` for the UI;
- optional `quoteWindowMs`, how long quotes may race (integer milliseconds, 100
  to 10000; default 3000). A seller that has not answered when the window closes
  is cooled down like one that refused.

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
healthy snapshots. The quote window defaults to 3 seconds: in the first real
test a quote through a distant relay took about 250 ms each way, so the earlier
300 ms often expired before any quote arrived (`NO_ACCEPTABLE_CONTROL_OFFER`). A
quote still wins as soon as it arrives, so the window only bounds how long a
slow seller can take. A downgrade cannot win while an exact candidate is
pending, including at window expiry. Quotes reserve no capacity. Idle HTTP
connections are retired before control queries so the shared transport admission
still applies. Control connections close before v1 HTTP forwarding.

A different seller returns `SELECTED_SELLER_NOT_TRUSTED` (HTTP 409), with no
inference forwarding or payment. The trusted seller can proceed only through its
unchanged stored v1 offer. Quotes are never converted into v1. Because v1 has no
reasoning selection or separate selection-budget enforcement, execution requires
`off` reasoning, matching engine description/payment identities/prices/metering,
and the same maximum budget as the stored v1 offer. Other terms return
`QUOTE_REQUIRES_UNSUPPORTED_V2_EXECUTION`. This paid entry never executes free
v2; use the separate free buyer endpoint below.

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

## Optional seller discovery publication

The seller can publish its signed public catalog/presence to the HTTP index with
`GYBLOS_DISCOVERY_PUBLISH=1`. `GYBLOS_DISCOVERY_URL` overrides the configured
base URL; publication is off by default. See
[discovery.md](discovery.md#seller-duties) for renewal, retry, shutdown and
sequence-state recovery limits. Do not reset `public-sequence-v2.json` or
automatically remove a leftover sequence lock. Catalogs and quotes never outlive
the seller's current checked readiness observation; publication does not run an
engine or enable v2 payments. Creating/deploying an index is a separate operator
action, described in [discovery-index.md](discovery-index.md).

## Free v2 seller execution

A supported `gyblos.toml` free offer starts control plus the separate
`gyblos/free/3` complete-response and `gyblos/free-stream/3` streaming data
channels. The daemon has no paid HTTP service or v1 offer; paid v2 offers use
the separate paid stream described in the protocol spec. This is execution for
the pinned engine's single user message and `off` reasoning; other engine input
forms are not enabled. The separate `buyer:free` entry executes free quotes;
obtaining a control quote alone still does not send a prompt.

The seller reads daily token caps from the prepared offer: `daily_token_cap`
applies across all buyers and `per_buyer_cap` per authenticated NodeId, both
counting input plus output tokens. The buyer cap is best effort: generating a
new NodeId bypasses that identity's allocation but not the shared offer cap.
Input plus maximum output is reserved before inference; only a valid recounted
completion returns unused tokens. Errors/cancellation retain the reservation.
Caps are in memory and reset on restart, so they do not promise durable daily
limits. Renewing availability does not reset them.

How tokens are counted depends on the offer's metering mode, which every quote
carries. A model whose public tokenizer is pinned is **recounted**: the seller
counts the prompt and output with that tokenizer, as the buyer can ("Uso
medible"). Any other model is **declared** ("Uso declarado"); today that is any
model the `openai` plugin serves other than Qwen3 0.6B, and every model the
`anthropic` plugin serves. The reported usage is then the engine provider's,
which the buyer cannot check:

- admission reserves the prompt's UTF-8 bytes plus 64 tokens for the provider's
  chat template, and the reservation is never refunded;
- a stream stops with `FREE_EXECUTION_LIMIT_EXCEEDED` once it would deliver more
  than 32 bytes per allowed output token;
- a count below one input token, below one output token per 32 delivered bytes,
  above `maxTokens` or beyond the model's context is the provider's invalid
  response (`SELLER_CANNOT_CONTINUE`, reason `engine_invalid_response`);
- a stopped stream reports its delivered bytes, at most `maxTokens`.

An engine on this machine renews readiness with a one-token private warmup and
memory checks; an engine the seller pays per call renews by describing its model
only, and never generates for readiness.

Token caps belong to each free offer, and each offer has its own readiness: one
offer generating or renewing never makes another's quotes busy, and a quote for
an offer the catalog no longer lists is refused with
`CONTROL_MODEL_UNSUPPORTED`. Quotes are single-use through expiry across the
whole seller, which also runs one free generation at a time and counts
`max_free_buyers_per_day` across all its offers; a request whose selection no
offer serves is refused with `FREE_EXECUTION_UNSUPPORTED`. Replay state is
bounded; startup rejects quotes issued at or before its startup timestamp. A
trustworthy wall clock is required across restarts. Disconnecting or retrying
never refunds uncertain work or permits reuse of a consumed quote. An engine
ignoring cancellation keeps its slot occupied until it settles. No fallback is
allowed after any prompt bytes have been sent. Nothing on this channel
authorizes payment.

### Free-service availability limits

The seller's buyer table is bounded at 1,024 NodeIds per UTC day by default
(`max_free_buyers_per_day` in [`[limits]`](configuration.md#seller-limits), at
most 65,536). A peer that controls many cheap NodeIds can fill it while using
only a small part of the daily token budget; further new buyers then receive
`FREE_EXECUTION_BUSY` until the next UTC day or restart. Existing tracked buyers
retain their own limits. A shared overflow policy is a follow-up; the current
bound protects memory and does not guarantee fair access.

After admission, cancellation retains the full input-plus-output reservation,
even when no answer was received. Repeated cancellations across cheap NodeIds
can exhaust the shared daily budget. No output is not proof that the engine did
no work, so refunds for proven pre-execution cancellation need separate engine
lifecycle evidence; they are not enabled here. A generation rejection, including
cancellation, also invalidates cached readiness. Quotes remain closed until the
next successful background check (normally scheduled on a 10-second tick, plus
probe time; longer outages can take longer).

Free quotes retain the shared v2 metadata shape: `authorizer` and `feePayer`
contain the owner's address as placeholders. Both prices and `maxAtomic` are
zero; these fields assign no payment authority and no auxiliary payment signer
is loaded. Paid v2 requires separate admission checks before it can exist.

Switching a home from paid to free can leave a prior `offer.json` in place. It
is not renewed or advertised by the free service, whose endpoint exposes only
control and free ALPNs. Startup deliberately preserves existing role files;
operators should use current signed v2 quotes rather than that old file.

## Free v2 buyer endpoint

`pnpm buyer:free` starts a separate loopback endpoint on the buyer proxy port
(default `127.0.0.1:4031`). Stop `buyer:start` first; both commands use that
port. It needs the buyer role's public configuration, node key and the
`selection.json` policy described above. It does not load a wallet signer,
trust/offer files or a tokenizer, and does not check a payment program or
contact RPC. Existing role configuration retains its legacy asset/RPC fields,
but this entry does not use RPC. Keep seller owner–NodeId bindings independently
verified; discovery only supplies signed availability hints for those configured
identities.

Set `request.reasoning` to `"off"`, `lowestReasoning` to `null`, and `maxTokens`
to at most 128 (the current engine maximum). For a clear operator policy, set
`maxAtomic`, `inputAtomicPerMtok` and `outputAtomicPerMtok` ceilings to `"0"`.
The free entry enforces those zero ceilings/budget even if a shared selection
file permits paid quotes. `pinnedNodeId`, data-retention filters and configured
relays still apply; `PINNED_SELLER_IN_COOLDOWN` retains `cooldownUntil` in the
error object. Badges stay `declared-usage` and `openChannel` stays false.

If startup fails, `buyer:free` prints `FREE_BUYER_CONFIGURATION_REQUIRED` with a
reason and a next step, for example `BUYER_ROLE_MISSING` (run `node:setup`),
`SELECTION_CONFIG_MISSING` or `SELECTION_CONFIG_INVALID` (create or fix
`selection.json` in the buyer home), `SELECTION_STATS_INVALID`,
`DISCOVERY_STATE_UNAVAILABLE` or `IDENTITY_STATE_UNAVAILABLE` (a state file
beside it), `SELECTION_MAX_TOKENS_TOO_HIGH`, `SELECTION_REASONING_UNSUPPORTED`,
`BUYER_NODE_KEY_MISMATCH`, a relay code such as `MISSING_RELAY_TOKEN`, or
`BUYER_PORT_IN_USE`. No path or file content is printed.

Supported request shape for `POST /v1/chat/completions`:

```json
{
  "model": "the-exact-configured-model-id",
  "messages": [{ "role": "user", "content": "Your text" }],
  "max_tokens": 64,
  "stream": false
}
```

`max_tokens` defaults to the configured maximum and cannot exceed it. `model`
selects the exact configured model/variant/quantization tuple; it is not an
engine name. Only one text user message is supported. History, system messages,
tools, sampling options, alternate modalities and unknown options are rejected
before selection or prompt transmission. This is a limited compatible subset,
not the complete OpenAI API. Requests must send
`Content-Type: application/json`. Invalid UTF-8, foreign Host headers, requests
with an Origin header and other content types get 400 (a foreign Host gets 421),
so a web page cannot reach the endpoint; there is no CORS browser interface. A
body declared larger than 128 KiB gets 413 before it is read; a larger streamed
body gets the same 413 once it passes the limit. Both close the connection. Use
a local client, and apply normal trust to local processes.

Set `stream` to `true` for incremental `text/event-stream` responses. Each
`data:` event is an OpenAI-compatible `chat.completion.chunk` with a content
delta. Successful completion sends a finish reason and usage, then `[DONE]`. The
default (absent or `false`) remains one complete JSON response. Streaming
supports the same single-user, reasoning-off input and rejects unsupported
options such as `stream_options` rather than silently dropping them.

Fragments are provisional until a verified terminal and clean end of the Iroh
stream. A failure after SSE starts sends a static error and closes without
`[DONE]`; an error before SSE starts uses the JSON error response below. The
stream sets `x-should-retry: false`. A disconnect or deadline cancels execution;
after possible prompt transmission the buyer never retries or switches seller,
even before the first fragment. Writes await backpressure. Complete and
streaming execution share replay/caps; cancellation keeps a conservative full
token reservation. This free buyer does not invoke the separate paid-v2 path.

Status codes: 400 for an invalid request or a request beyond the quote's limits,
413 for an oversized body, 429 when the endpoint is already running a request
(safe to retry), 503 when no seller could take the request, 504 when the
endpoint's 180-second deadline expires, and 500 for an unexpected failure.
Whenever the prompt may already have reached a seller, or the request is the
caller's fault, the error carries `x-should-retry: false`, the header the
official OpenAI SDKs honor to skip their automatic retries. Clients that retry
5xx on their own must check it: retrying would resend the prompt, possibly to
another seller.

A refused request (`FREE_BUYER_INVALID_REQUEST`, 400) names the offending field
in `error.param` (`model`, `messages`, `max_tokens`, `stream`, or an unsupported
field such as `temperature`) and says why in `error.message`, for example
`max_tokens must be an integer from 1 to 128`. The reason is fixed text or the
operator's own limits, never the prompt.

When a seller drops out of a selection, `buyer:free` prints one stderr line:
`FREE_BUYER_SELLER_FAILED <first 8 hex of the NodeId> <phase> <code>`. The phase
is `identity`, `connect` (dial, catalog or presence), `discovery`, `quote` (the
seller refused, for example `CONTROL_MODEL_UNSUPPORTED`) or `timeout` (no quote
before the window closed). The line carries no address, key or error text.

When a seller's engine fails after it accepted the request (for example a
reseller out of quota, rate limited, or an engine that stops mid-answer), the
error code is `FREE_EXECUTION_SELLER_CANNOT_CONTINUE` and `error.reason` says
why: `quota_exhausted`, `rate_limited`, `engine_unavailable`,
`engine_interrupted`, `engine_timeout` or `engine_invalid_response`. Before the
first token this is a 503 JSON error. Mid-stream it is the final SSE error
event, which also carries `error.usage.completion_tokens`: the tokens the seller
delivered before it stopped. The buyer does not retry or reroute.
`FREE_EXECUTION_ENGINE_UNAVAILABLE` remains the refusal before generation, for
example when the seller's engine readiness has expired. A pinned model that
disappears during a request is reported as `engine_unavailable`.

The response contains one `choices` entry, its text/finish reason and
`usage.prompt_tokens`, `completion_tokens` and `total_tokens`. Static failures
use `error.code`; arbitrary exception contents are never returned. No prompt or
response is written to logs, journals or selection metadata. A free seller can
still observe the submitted text; free does not imply private or verified.

Control connections close before execution connects on `gyblos/free/3` or
`gyblos/free-stream/3`. The client verifies the seller peer, signed quote, local
buyer NodeId, exact terms and zero-skew expiry again before sending.
Request/response bounds and correlation use the free protocol codec. A query has
an absolute 180-second budget including discovery, quotes and execution; each
transport also retains its stage bounds. A failed seller may be excluded and
selection repeated only before sending begins, and no seller is executed twice
in one local request. The free runtime admits one orchestration at a time with
no queue; overlapping requests return `FREE_BUYER_BUSY` rather than racing the
per-peer connection limit or poisoning another request's cooldown. Cancelled
selection attempts do not commit quote statistics. Control and execution
admission remain occupied until pending native work settles. The client marks
sending before the first frame write: partial writes, remote errors, timeouts
and lost responses never cause automatic failover afterward. Native work that
ignores cancellation retains its execution resource until it actually settles.
The v1 paid proxy remains a separate command.

Product contract tests use a synthetic engine and native encrypted loopback.
They are not the complete publication-to-answer acceptance: the separate lab
scenario with an in-process discovery index follows this buyer's integration.
Real Ollama, off-host/relay/CGNAT and production acceptance remain separate
operations. See the following paid-v2 section and the identity documentation for
their separate scope and limits.

## Paid v2 buyer endpoint

`pnpm buyer` reads `selection.json`: with `request.maxAtomic` above `"0"` it
starts the paid buyer on the same loopback endpoint, otherwise the free one.
Paid mode is devnet only and needs:

- the buyer role (`pnpm node:setup --role buyer --mint MINT`) whose `rpcUrl`
  serves devnet (checked by its genesis hash) and whose wallet holds devnet SOL
  and the test token;
- the pinned public tokenizer (`pnpm node:tokenizer`), because the buyer
  recounts every answer itself;
- `request.selection.modelId` `qwen3-0.6b`, reasoning `off`, `network` devnet
  and `asset` the role's mint, with `maxAtomic` the most one request may deposit
  and `priceCeilings` the highest prices it accepts (protocol fee included).

Each request takes one quote from a paid seller (a free winner, or a seller that
fails discovery or identity checks, is skipped before anything is signed), signs
one channel open for at most `maxAtomic`, streams the answer and checks the
seller's settlement against the buyer's own count. A completed answer, and an
error the seller answered after receiving the open, carries `gyblos_payment`:
the verdict, the ceiling, the buyer's expected charge, the seller's charge,
payout, fee and refund in atomic units, and whether a record was kept. A stream
cut before the seller answered, or the endpoint's own deadline, carries only the
error code. Only a single user message the model's chat template accepts is
sent; anything else is refused before paying.

One paid request runs at a time (`PAID_BUYER_BUSY`) and one buyer process holds
the payment journal (`BUYER_PAYMENT_JOURNAL_UNAVAILABLE`). The buyer never fails
over once a seller received the signed open, since that seller could still land
it; an open that never left the buyer is discarded and the next seller is tried.
Any channel in the journal not settled on the buyer's own count (a refusal, a
stop, a pending or lapsed claim, a dispute or a settlement the chain could not
confirm) blocks new payments (`PAID_BUYER_UNRESOLVED_PAYMENT`) until it is
reconciled; the buyer also appends it to `paid-records.jsonl` in the buyer home
when it can (`recorded`). Never reset or delete a journal or lock to bypass the
block.

To reconcile, stop the paid buyer and run `pnpm buyer:reconcile:paid`. It checks
that the role's RPC serves devnet, then reads each open channel's finalized
history; it only reads the chain and never signs. One JSON line per channel
reports the outcome, then a summary line with the count of each:

- `settled`: the claim charged exactly the buyer's own count;
- `disputed`: it charged another amount, more or less (recorded, no penalty);
- `unchecked`: the chain shows a charge but no record of the buyer's count
  survived;
- `never-opened`: nothing was charged, because the chain shows the open never
  landed and never can: no deposit in the channel's whole history, no channel
  account, the open's blockhash expired by finalized block height, and the RPC
  still holds history back to the open's slot;
- `open`: the channel is open and unclaimed, its open may still land, or the
  chain cannot prove otherwise (a pruned RPC, or more history than it reads).

The charge is what left the escrow minus what came back to the buyer's wallet.
If the program redirected the refund elsewhere (for example because the buyer's
token account was closed), it shows as a larger charge and a dispute, never a
smaller one. Each outcome but `open` is appended to `paid-reconciliations.jsonl`
in the buyer home before the journal unblocks it, so a failed run loses nothing
and the next one picks up where it stopped. An `open` channel keeps blocking
until the seller claims it or the buyer withdraws it (below).

Use the role's RPC as one endpoint with full transaction history. A pruned or
load-balanced RPC can only keep a channel `open` (it never makes one look
unopened), because the command reads the finalized tip first and requires the
RPC to still serve blocks and ledger back to the open's slot. A journal from
before this version is read as is: its signed opens can still settle but are
never reported `never-opened`.

The command exits 0 when nothing blocks payments (disputes included, since they
are recorded and no longer block), 2 while a channel stays open, and 1 when it
could not finish, printing `PAID_RECONCILE_NETWORK_MISMATCH`,
`PAID_RECONCILE_ROLE_INVALID` or `PAID_RECONCILE_INCOMPLETE` (stop the buyer,
check the RPC and the home). The v1 `buyer:reconcile` is unchanged.

A channel that stays `open` because nobody claimed it is withdrawn with
`pnpm buyer:withdraw:paid` (buyer stopped, devnet only). Unlike reconciliation,
it signs with the buyer's wallet key and pays each transaction's fee from the
wallet's devnet SOL. Each run visits every open channel in the journal and takes
it one step further, chosen from the channel's confirmed state. It prints one
JSON line per channel, then a summary with the count of each step and the
shortest `retryAfterSeconds`:

- `claimable`: the seller may still claim it with the buyer's authorization, so
  it is left alone. That lasts until the quote expires or `maxTimeoutSeconds`
  after the open was signed, whichever is later, plus 150 seconds for a claim
  sent just before then to land and for clock differences.
- `close-requested`: `request_close` was sent, which starts the channel's grace
  period (`withdrawDelay`, 60 seconds).
- `waiting`: the grace period has not elapsed by the chain's block time, or the
  RPC does not know that block's time yet.
- `distributed`: `seal` and `distribute` were sent, which pay out whatever was
  settled and refund the rest of the escrow. The same transaction first creates
  the buyer's token account if it was closed (at the wallet's cost in rent),
  because the program would otherwise send the refund to its own treasury.
- `nothing`: already distributed, or no channel account at the address.
- `refused`: the account is not this buyer's channel with the journaled rent
  payer and deposit and the current role's mint and network fee distribution, so
  nothing was signed for it. Restore the role's mint (or run the release the
  channel was opened with) and run again.
- `failed`: this channel's step failed with the static code in `failure`
  (`UPTO_UNAVAILABLE` for the RPC, `UPTO_CHAIN_REJECTED` when the chain or its
  preflight refused the transaction, which also happens when an earlier
  unconfirmed one has since landed or the wallet lacks SOL for the fee or the
  token account's rent). The other channels still take their step.

Each line also says whether its transaction confirmed within a minute. One that
did not is checked again after 30 seconds: run again before then and the same
step may be sent twice, and the second only costs a refusal (`failed`). The
command exits 2 while another run is needed, 0 when none is, and 1 when it
refused or failed a channel (`PAID_WITHDRAW_REFUSED`, `PAID_WITHDRAW_FAILED`,
after every channel was visited) or could not run
(`PAID_WITHDRAW_NETWORK_MISMATCH`, `PAID_WITHDRAW_ROLE_INVALID`,
`PAID_WITHDRAW_INCOMPLETE`).

It never changes the journal. Once a channel is distributed and finalized,
`pnpm buyer:reconcile:paid` reads it from history and unblocks payments: the
charge is what the seller had settled (usually nothing). If the buyer had
counted a delivered answer that the seller never claimed, that shows as
`disputed` with a smaller charge. A journal entry from before this version whose
open never landed shows `nothing` here, and reconciliation cannot prove it
unopened, so it keeps blocking payments.

The endpoint listens on loopback only and refuses browser requests, but any
local process can call it and spend up to `maxAtomic` per request: run the paid
buyer only on a machine you control, with a devnet wallet.

Startup reasons beyond the free ones: `BUYER_PAYMENT_NETWORK_MISMATCH` (RPC,
network or asset not devnet's test token), `BUYER_PAID_MODEL_UNSUPPORTED`,
`BUYER_WALLET_KEY_INVALID`, `BUYER_TOKENIZER_UNAVAILABLE` and
`BUYER_PAYMENT_JOURNAL_UNAVAILABLE`.

## Private free-inference receipts

Free sellers advertise `gyblos/receipt/1` alongside execution. After a verified
successful response, the free buyer requests the seller's signed receipt, checks
it against its own execution context, stores its countersigned pair and confirms
it. This is best effort: an unavailable channel, signer, disk or confirmation
never repeats the prompt or turns a successful answer into an inference failure.
The seller also retains seller-only failed/cancelled records when actual
recounted usage is available; unknown provider usage is omitted.

Each role stores a private `receipts/receipts-v1.json` beneath its configured
home (directories 0700, files 0600). It contains signed metadata, not prompts,
responses, keys, IPs or payment authorizations. Buyer token counts are null;
seller counts are not independent buyer measurements. Both signatures are
attestations, not proof of execution or usage. No collector or export is
enabled.

Retention is bounded to 256 records and 1 MiB, evicting oldest metadata first.
Seven-day expiry is logical: reads hide expired records; the next successful
write removes them physically. No background deletion is promised. Unsafe or
corrupt state disables receipt work, without repairing or truncating files. A
crash may leave `receipts-v1.lock`; there is no automatic lock reclamation.

One background receipt task per role/process runs at a time, without a queue.
Inference response/done frames never wait for receipt persistence. Seller
receipt work has a 500 ms budget; the whole buyer receipt exchange has 2 s. Late
uncancellable work keeps that receipt slot occupied and later receipt tasks are
dropped. Node health exposes content-free `receipts` counters (`active`,
`saved`, `failed`, `dropped`); `saved` records a finished task, not a collector
acknowledgment. Shutdown aborts receipt work. Receipt connections have their own
family cap, sharing endpoint global/source/rate limits with inference. Existing
inference admission, free caps, replay checks and payment paths remain
unchanged. No prompt retry is introduced by metadata retries.
