# Discovery

A discovery index is an untrusted cache of node-signed public records. Sellers
publish a signed catalog (the models they serve) and a short-lived presence
(proof they are online). Buyers ask the index which sellers list a model, then
verify every record themselves and contact each seller directly over Iroh.

- The client is `packages/discovery-http` (`@gyblos/discovery-http`).
- The default index is `https://discovery.gyblos.com/v1` (`DISCOVERY_INDEX_URL`
  in `@gyblos/config`). Anyone can run another one.
- The reference index is `apps/discovery-index`; its endpoints, limits and
  storage are in [discovery-index.md](discovery-index.md).
- The signed record formats, domains and signing bytes are in
  [`packages/protocol/SPEC.md`](../packages/protocol/SPEC.md). This page owns
  the trust model, the buyer and seller duties and the HTTP wire contract.

## Trust model

The index never vouches for identity and never sees prompts, offers or payments.
Assume it can lie, omit sellers, replay old records or return garbage. The
client therefore:

- re-verifies every entry with protocol `verifyPublicV2`: the catalog's Ed25519
  signature by its NodeId under the v2 domain, both lifetimes at the caller's
  `now`, and the presence against that exact catalog (owner, NodeId, sequence,
  lifetime and `catalogDigest`);
- drops and counts (`dropped`) entries that fail, list another model, are at or
  below the caller's `lastSequence`, or lose to a higher-sequence entry for the
  same NodeId, instead of failing the whole page;
- reads at most about 1 MiB before `JSON.parse`, validates the page shape
  strictly, applies one deadline to the whole request and refuses redirects;
- accepts only `https` base URLs (plain `http` only on loopback, for tests).

A verified record proves only that the NodeId key signed it. The `owner` field
is self-declared: the buyer still checks the owner-to-NodeId binding in the 8004
agent registry (see [identity.md](identity.md)) before it selects a seller.

## Client API

All functions take an injected `fetch` and never use the global one. Each
accepts an optional `timeoutMs` and `signal`.

| Function                                                                       | What it does                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fetchSellers({ baseUrl, model, fetch, now, limit?, cursor?, lastSequence? })` | Returns `{ sellers, dropped, next, generatedAt }`. Each seller is `{ catalog, presence, withdrawal: null }` (`DiscoveredSeller`). `limit` (default 50, at most 200) is always sent. A NodeId repeated within a page keeps its highest catalog sequence. `next` is the opaque cursor. |
| `publishRecord({ baseUrl, record, fetch })`                                    | Posts one signed record (body at most 34,816 bytes). Resolves `{ ok: true }` on `201`.                                                                                                                                                                                               |
| `registerSeller({ baseUrl, invite, nodeId, fetch })`                           | Trades a one-use invite code for permission to publish (`POST /registrations`). Resolves `registered` (`201`) or `already-active` (`200`). The invite code never appears in an error.                                                                                                |
| `validateDiscoveryBaseUrl(url)`                                                | Applies the client's URL policy to operator configuration: `https`, or `http` on loopback; no credentials, query string or fragment.                                                                                                                                                 |

Failures throw `DiscoveryError` with a static code from `DISCOVERY_ERROR_CODES`
and, when a response arrived, its `status`. Messages never echo input or
response text.

| Index answer                                                                      | Client code                                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `400` `INVALID_RECORD`, `INVALID_SIGNATURE`, `EXPIRED_RECORD`, `UNKNOWN_CATALOG`  | `DISCOVERY_` plus the same name                                                        |
| `400` with an unreadable body or another code on publish                          | `DISCOVERY_RECORD_REJECTED`                                                            |
| `400 HTTPS_REQUIRED`                                                              | `DISCOVERY_INSECURE_URL`                                                               |
| `409` on publish or read                                                          | `DISCOVERY_STALE_RECORD`                                                               |
| `403` on publish                                                                  | `DISCOVERY_PUBLISH_NOT_ALLOWED` (the index does not accept this NodeId as a publisher) |
| `403` `INVITE_INVALID`, `IDENTITY_NOT_REGISTERED`, `NODE_REVOKED` on registration | `DISCOVERY_` plus the same name                                                        |
| `400 INVALID_REGISTRATION`, or another `400`/`403` body on registration           | `DISCOVERY_REGISTRATION_REJECTED`                                                      |
| `413`, `429`, `503`                                                               | `DISCOVERY_PAYLOAD_TOO_LARGE`, `DISCOVERY_RATE_LIMITED`, `DISCOVERY_UNAVAILABLE`       |
| Any other status                                                                  | `DISCOVERY_HTTP_STATUS`                                                                |

A deadline is always `DISCOVERY_TIMEOUT`, including one that ends while reading
a rejection body. A caller `signal` cancels header and body reads with
`DISCOVERY_CANCELLED`, even when the injected `fetch` ignores its signal.

## Buyer duties: replay and withdrawal

`fetchSellers` verifies each page on its own and keeps no state. A hostile index
can replay an older record pair that has not expired, or hide a withdrawal and
keep serving the withdrawn catalog. The protocol (SPEC.md, "Trust, references,
replay and withdrawal") makes the consumer responsible for replay state. Before
selecting a seller, the buyer merges index results against its own per-NodeId
state:

- Persist one high-water sequence per NodeId, shared by catalog, presence and
  withdrawal. Keep withdrawal tombstones at least through the maximum catalog
  lifetime. Never reset them on restart.
- Pass `lastSequence: (nodeId) => highWater.get(nodeId)`. Entries whose presence
  sequence is at or below the known value are dropped and counted, so `sellers`
  holds only what is newer than the buyer's state. Raise the high-water mark
  atomically when you accept an entry.
- Never let an index result revive a catalog you hold a withdrawal for. Only a
  higher-sequence catalog reopens it. The index never serves withdrawals, so
  `withdrawal` is always `null`.
- A cold buyer with no state can't detect a replay. The exposure is bounded by
  the presence lifetime (90 s), because every entry needs a live presence.
- Cap the number of pages you follow: `next` comes from the index, and a
  malicious index can return a cursor forever.

## Buyer runtime integration

To use the default index, add `discovery` to the buyer's `selection.json`:

```json
{
  "discovery": {}
}
```

Inside `discovery` you can set `baseUrl` (same URL policy as the client) and
`maxPages` (1 to 8, default 3). Each page holds at most 50 entries, and the
whole discovery step has a 10-second deadline. A cursor cycle, or a non-final
page at the page cap, fails with `BUYER_DISCOVERY_LIMIT`, and no quotes are
requested. An index error stops selection; it never switches the buyer to a
different payment path. The rest of `selection.json` is described in
[running-a-node.md](running-a-node.md#optional-buyer-selection-and-discovery).

The index only supplies candidate NodeIds. The `sellers` list in
`selection.json` stays an independent NodeId/endpoint list with expected owners.
With `identity` configured, the buyer checks each owner in the 8004 agent
registry and keeps durable binding floors (see
[identity.md](identity.md#durable-buyer-identity-admission)); only an explicit
per-seller `manualTrust: true` overrides that check. Unknown or mismatched index
identities are discarded before anything is stored or dialed. Every candidate
must then return a fresh signed catalog and presence over authenticated Iroh.
The buyer rechecks identity, exact references and replay state, and persists
what it observed before selection. The final quote rechecks the latest durable
catalog and withdrawal barrier.

The buyer keeps its replay state in `discovery-state-v2.json` in the buyer home:
owner, NodeId, shared high-water sequence, catalog and presence digests and
expiries, and withdrawal and conflict sequence barriers. It caches no signed
proof or offer. Equal-sequence conflicts block a NodeId until a higher catalog
arrives. Withdrawals learned from configured signed records survive restarts and
configuration changes.

The file uses mode 0600 in a 0700 buyer directory, staged replacement and file
and directory synchronization. Updates run under an exclusive
`discovery-state-v2.lock`. The buyer stops selection, and does not repair
anything on its own, when:

- the lock exists (the buyer never breaks it, even after a crash);
- the state is malformed, has unsafe permissions, or cannot be persisted;
- the state reaches 1,024 identities or 1 MiB (tombstones and high-water marks
  are never pruned).

Repair is a deliberate operator step: stop every buyer that uses this home
before you remove a leftover lock. Never delete the state file to clear an
error, because that also drops the replay protection it holds. Power-loss
durability on Windows is not established.

### Open discovery

With `"discovery": { "open": true }`, which requires `identity`, free requests
can also use sellers that `selection.json` does not list:

```json
{
  "identity": { "rpcUrl": "SOLANA_DEVNET_RPC_URL" },
  "discovery": { "open": true }
}
```

Replace `SOLANA_DEVNET_RPC_URL` with an `https` devnet RPC URL without
credentials or a query string; the other `identity` settings are in
[identity.md](identity.md#durable-buyer-identity-admission).

- For each catalog the index lists for the model, the catalog's owner must hold
  that NodeId in the 8004 agent registry. The buyer checks this before it
  remembers anything, exactly as for a configured seller.
- The buyer dials such a seller by NodeId through the first configured relay
  (`relays.urls` in `config.toml`, or `GYBLOS_RELAYS`). The index supplies no
  address.
- Configured sellers come first, and the candidate list stays within 16. With
  open discovery, `sellers` may be empty.
- `buyer:free` uses open sellers directly. The automatic buyer (`buyer:start`,
  `buyer:chat`, the desktop app) asks its configured sellers first at the
  request's own ceilings. When none can serve, or none is configured, it asks
  the open network at zero price ceilings. A request never goes back to a seller
  it already tried.
- Paid requests and payment sessions use configured sellers only.
- Stats for open sellers live in memory only; `selection-stats.json` keeps the
  configured sellers alone.

Open discovery has its own bounds:

- Each selection makes at most 16 new identity lookups. An identity the registry
  refused is not looked up again for five minutes.
- At most 64 live unconfigured candidates are eligible at once, counted under
  the discovery lock from signed expiry and withdrawal or conflict state.
  Expiry, withdrawal or conflict frees a slot without deleting any replay floor.
  Registry refusals take no slot.
- Configured sellers never count toward the 64. If the state already holds more
  than 64 live unconfigured rows, eligibility is limited by NodeId order until
  rows expire.
- Identity and discovery histories each keep at most 1,024 rows, with room for
  configured sellers. A full history refuses new identities without affecting
  known ones.

## Seller duties

Publishing is opt-in. Without it, the seller node sends no request to any
discovery index. `gyblos init` asks whether to list the seller in the public
discovery index and writes the answer to `config.toml`:

```toml
[discovery]
publish = true
# url = "https://discovery.gyblos.com/v1"
```

The `--discovery-publish` and `--discovery-url` flags and the
`GYBLOS_DISCOVERY_PUBLISH` and `GYBLOS_DISCOVERY_URL` variables override the
file; [configuration.md](configuration.md) has the precedence. The URL follows
the client's URL policy.

Publishing alone does not list the seller on the reference index. The index
accepts records only from NodeIds it admits: a seller registers its NodeId once
with an invite code (`gyblos seller register`; see
[running-a-node.md](running-a-node.md#seller-registration-beta-invite)). Until
then, every publish fails with `DISCOVERY_PUBLISH_NOT_ALLOWED`.

### Publisher

The publisher sends a signed catalog before its presence and keeps both fresh.
Publication failures appear as a static degraded health status. They never start
inference or payment, and never change the paid route.

| Behavior                  | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| Publish check             | every 10 seconds                                                         |
| Request deadline          | 5 seconds, covering headers and body                                     |
| Backoff after a failure   | 10, 20, 40, then 60 seconds (capped)                                     |
| Uncertain acknowledgement | the next attempt signs a fresh, higher-sequence catalog (never a replay) |
| Catalog                   | rotated before it expires                                                |

### Model readiness

Catalog renewal depends on a model-readiness observation. The publisher and
control queries never probe, warm or load the engine. A separate lifecycle:

- checks every 10 seconds, and starts a bounded private one-token warmup when
  the observation has two minutes left, or after it expired or failed;
- checks memory headroom before and after, rejects new out-of-memory events, and
  verifies the startup model name, digest and context;
- anchors a new four-minute observation to each successful warmup;
- skips a check while inference is busy, and cancels a pending check when
  inference starts, so a late result can't restore availability;
- gives each check a 90-second deadline and one work slot, held until the
  underlying work settles, with no queued backlog.

During a check, a failure, expiry or shutdown, local catalogs, presence and
quotes fail closed at once. The publisher retires on its next tick. Recovery
needs a higher catalog tied to the new observation. These observations say the
model was ready recently; they don't reserve capacity or guarantee admission.

### Shutdown and withdrawal

On shutdown the seller disables local catalog and quote snapshots, cancels
in-flight publication, and tries once to publish a higher signed withdrawal
while the catalog is still valid. If the withdrawal fails, the index drops the
seller when its signed presence and catalog expire.

The shared presence-work queue holds at most 32 entries (the control query
capacity). If a disk operation stalls, cancelled entries keep their slots until
it settles, so later requests are refused instead of piling up.

### Public sequence file

Catalogs, HTTP presence, Iroh presence and withdrawals all reserve their
sequence from one allocator before signing. The seller home stores its
high-water mark in `public-sequence-v2.json`, bound to the NodeId, with mode
0600 in a 0700 seller directory, an exclusive per-update lock and synchronized
atomic replacement. A sequence is never reused, even when signing or delivery
fails. Malformed or wrong-node state, unsafe paths, lock contention, overflow or
an observed rollback stop publishing.

Keep `public-sequence-v2.json` across restarts and backup restores. Deleting or
rolling back local state is not a supported recovery, because there is no
hardware anti-rollback anchor.

A crash, a forced kill (`kill -9`), power loss, or Ctrl-C during startup can
leave `public-sequence-v2.lock` behind. The seller never breaks it on its own,
and `gyblos doctor` reports `SEQUENCE_LOCK_PRESENT`. To recover:

1. Stop every seller that uses this `GYBLOS_HOME`, including a lab harness. For
   example, check with `pgrep -fl 'gyblos|bin.ts start'`.
2. In the seller directory, remove `public-sequence-v2.lock` and any
   `public-sequence-v2.json.*.tmp` beside it.
3. Run `gyblos doctor` again. `SEQUENCE_LOCK_PRESENT` no longer appears.

Never edit or delete `public-sequence-v2.json` itself.

## Running an index (wire contract)

Anyone can run an index: multiple discovery sources are part of the design (see
[public-decisions.md](public-decisions.md)). The client and the reference index
both follow this contract. Record formats and signing bytes stay in SPEC.md; the
HTTP service around them can change without touching signatures or golden
vectors.

An index checks records to keep junk out, but acceptance proves only that the
NodeId key signed them. It never vouches for owner identity, registration or
availability, and clients re-verify everything. An index has no reason to store
or log IP addresses, prompts, offers or payments.

The reference base URL is `https://discovery.gyblos.com/v1`. All paths below are
relative to the base URL. The client refuses redirects, so configure the exact
base URL.

Common rules:

- **HTTPS only.** A request that doesn't arrive over `https`, whatever its
  method or path, gets `400 {"error":"HTTPS_REQUIRED"}` before any other check.
  It is never redirected, so a request body is never resent in the clear. An
  index created for development also accepts `http` on a loopback host.
- **Errors** are `{"error":"<CODE>"}` with a static code. An index never echoes
  request input. Unknown paths answer `404 {"error":"NOT_FOUND"}`.
- **Headers.** Every response carries `X-Robots-Tag: noindex` and
  `X-Content-Type-Options: nosniff`. `GET` and `HEAD` on `/sellers`, `/models`,
  `/uptime` and `/health` carry `Access-Control-Allow-Origin: *` on every
  status, errors included. A `200` from `/sellers`, `/models` or `/uptime`
  carries `Cache-Control: public, max-age=10`; every other response carries
  `Cache-Control: no-store`.
- **No sessions or CAPTCHA.** Publishers authenticate by signature. Rate limits,
  the size cap and one stored record per kind per NodeId bound abuse.

### `POST /records`

- **Request:** `Content-Type: application/json` (optionally `; charset=utf-8`),
  body exactly `{"record":<signed envelope>}`, where the envelope is
  `{"record":<public v2 record>,"signature":"<hex>"}`. At most 34,816 bytes (a
  canonical record may be 32 KiB, plus the envelope).
- **Checks:** strict shape (unknown fields rejected), canonical encoding and
  size, the Ed25519 signature by `record.nodeId` under the v2 domain for its
  kind, and lifetimes against the index clock. A record may be issued up to 5 s
  ahead of the index clock, with no expiry grace (`issuedAt <= now + 5 s`,
  `now < expiresAt`), and lives at most 600 s (catalog and withdrawal) or 90 s
  (presence).
- **Sequence:** one high-water mark per NodeId, shared by all three kinds. A
  record at or below it is stale. The mark outlives the record by at least the
  600 s catalog lifetime, so stale replays stay rejected.
- **References:** a presence or withdrawal must reference the NodeId's current,
  live, non-withdrawn stored catalog exactly as `referenceV2` in
  `packages/protocol` does.
- **Effects:** a catalog replaces the NodeId's catalog and clears its presence.
  A presence replaces the previous presence. A withdrawal tombstones the
  referenced catalog and clears its presence. Only a higher-sequence catalog
  reopens a withdrawn NodeId; a presence never revives it.
- **Admission:** an index may accept records only from NodeIds it admits (an
  allowlist or registration). It may refuse an unadmitted claimed `nodeId` with
  `403` before verifying the signature.

| Status | Body                    | Meaning                                                         |
| ------ | ----------------------- | --------------------------------------------------------------- |
| `201`  | `{"ok":true}`           | Stored.                                                         |
| `400`  | `INVALID_RECORD`        | Wrong content type, shape, encoding or size of the record.      |
| `400`  | `INVALID_SIGNATURE`     | Signature does not verify.                                      |
| `400`  | `EXPIRED_RECORD`        | Not valid yet, expired, or lifetime too long.                   |
| `400`  | `UNKNOWN_CATALOG`       | Reference does not match a live, non-withdrawn stored catalog.  |
| `400`  | `HTTPS_REQUIRED`        | The request did not use `https` (any route).                    |
| `403`  | `PUBLISH_NOT_ALLOWED`   | The index does not admit this NodeId as a publisher.            |
| `409`  | `STALE_RECORD`          | Sequence at or below the NodeId's high-water mark.              |
| `413`  | `PAYLOAD_TOO_LARGE`     | Body over 34,816 bytes.                                         |
| `429`  | `RATE_LIMITED`          | Per-IP, per-NodeId or capacity limit; `Retry-After` in seconds. |
| `503`  | `DISCOVERY_UNAVAILABLE` | Storage, limits or publishing not configured, or a failure.     |

### `POST /registrations`

An index that admits publishers by invite code exposes this route. The body is
`{"invite":"gyb_<26 base32 characters>","nodeId":"<64 lowercase hex>"}`. The
index reads the NodeId's 8004 agent registry binding itself; the request carries
nothing else.

| Status | Body                            | Meaning                                                                    |
| ------ | ------------------------------- | -------------------------------------------------------------------------- |
| `201`  | `{"ok":true,"status":"active"}` | Admitted; the invite code is spent.                                        |
| `200`  | `{"ok":true,"status":"active"}` | Already admitted (a retry with the same invite code, or an active NodeId). |
| `400`  | `INVALID_REGISTRATION`          | Wrong content type, size or shape.                                         |
| `403`  | `INVITE_INVALID`                | Unknown, expired or spent invite code.                                     |
| `403`  | `IDENTITY_NOT_REGISTERED`       | No 8004 agent registry binding for this NodeId.                            |
| `403`  | `NODE_REVOKED`                  | The index operator revoked this NodeId.                                    |
| `413`  | `PAYLOAD_TOO_LARGE`             | Body over the index's limit.                                               |
| `429`  | `RATE_LIMITED`                  | Rate limit; `Retry-After` in seconds.                                      |
| `503`  | `DISCOVERY_UNAVAILABLE`         | Registration not configured, registry unreachable, or a failure.           |

### `GET /sellers?model=<modelId>&limit=<n>&cursor=<c>`

- `model` is required: a model identifier of at most 128 characters in the
  protocol identifier charset. `limit` defaults to 50; larger values than 200
  are clamped. `cursor` is the `next` value of a previous page. A missing or
  malformed `model`, a malformed `limit` or `cursor`, an unknown parameter, or a
  repeated parameter gives `400 {"error":"INVALID_QUERY"}`.
- The `200` body is
  `{"sellers":[{"catalog":<envelope>,"presence":<envelope>}],"next":<cursor or null>,"generatedAt":<index time in ms>}`.
  Envelopes are returned byte-for-byte as published.
- A seller is included when its current catalog lists `model`, is live and not
  withdrawn, and its current presence is live and references that catalog. Order
  is deterministic (reference index: presence `issuedAt` descending, then
  NodeId). Ranking is the buyer's job.
- Cursors are opaque: pass `next` back verbatim, and never parse or build one.
  The client accepts 1 to 512 characters of `[A-Za-z0-9._~-]`. `next` is `null`
  on the last page.
- The response is at most 1 MiB. The index stops adding entries before that size
  and returns `next`, so a page can hold fewer than `limit` entries.
- An index may serve a `200` page from a cache for up to 10 seconds, so
  `generatedAt` can be that old. Errors are never cached.
- Errors: `400 INVALID_QUERY`, `400 HTTPS_REQUIRED`, `429 RATE_LIMITED`,
  `503 DISCOVERY_UNAVAILABLE`.

### `GET /models`

Takes no parameters; any query is `400 INVALID_QUERY`. Returns
`{"models":[{"id":"<modelId>","sellers":<n>}],"generatedAt":<ms>}`: every model
listed by live sellers (the same liveness as `/sellers`), with its seller count,
most sellers first and then by model ID, at most 500. It is a hint for showing
the network's models by name; each seller is still found with `/sellers` and
verified as usual.

### `GET /health`

Returns `200 {"ok":true,"records":<count of stored unexpired records>}` or
`503 {"error":"DISCOVERY_UNAVAILABLE"}`. The reference index adds `"publish"`,
its publish mode; clients must not rely on it.

### Reference index extensions

The reference index also serves `GET /uptime?node=<NodeId>`, a public uptime
report built from the presences it accepted. It is not part of the contract a
client relies on; see [discovery-index.md](discovery-index.md#uptime).
