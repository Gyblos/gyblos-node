# Running a seller and a buyer

A seller node serves paid inference over Iroh. A buyer proxy on another machine
forwards local requests to it. Both are devnet-only and experimental.

## Roles and files

Each role lives in `.local/p2p/` of its working directory, so run the seller and
the buyer from **different** checkouts or machines. `pnpm node:setup --role`
creates the role file, the Iroh node key (`node.key`) and the role's Solana keys
with private permissions. It never overwrites existing keys; a mismatched
existing role stops with an error.

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
pnpm gate:inference:setup        # pinned Qwen3 0.6B model and tokenizer
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
- Only `/v1/chat/completions` is reachable over Iroh. Stop with Ctrl-C.

## Buyer

```sh
export GYBLOS_RELAY_TOKEN=...
pnpm node:setup --role buyer --mint MINT
pnpm buyer:setup             # download and verify only the pinned tokenizer
# copy the seller's .local/p2p/offer.json into this .local/p2p/
# write .local/p2p/trust.json (see below)
pnpm buyer:start
```

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

`buyer:setup` downloads public tokenizer files into `.local/devnet/tokenizer/`
in the buyer checkout. It does not install Ollama, download model weights, read
keys or contact Solana. Run it once before the synthetic paid-call CLI.

There is no command that writes `trust.json` or funds P2P roles yet (the
archived Docker lab did both). Give the buyer address test tokens of `MINT` with
your own Solana tooling.

The proxy listens on `127.0.0.1:4031` and accepts only
`POST /v1/chat/completions` with a loopback `Host`. It runs one request at a
time; a second waits and a third gets 429. Malformed JSON gets 400
`MALFORMED_JSON`. A transport failure returns 503 and is treated as an uncertain
payment, never retried.

One paid synthetic call through a running proxy: `pnpm buyer:call 0` (case 0, 1
or 2). It records journals and measurements in `.local/p2p/`.

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

- `GYBLOS_RPC_URL`: devnet RPC; the genesis hash is checked before use.
- `GYBLOS_P2P_RUN_ID`: optional label copied into `status.json` and evidence.
- Ports: buyer proxy 4031, seller HTTP 4032 (loopback only), facilitator 4022,
  Ollama 11436. Stop other gates before starting a seller.

Facilitator diagnostics for the seller are written privately under
`.local/p2p/facilitator-diagnostics/`; see [payments.md](payments.md).
