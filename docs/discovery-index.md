# Discovery index Worker

`apps/discovery-index` (`@gyblos/discovery-index`) is the reference discovery
index: a Cloudflare Worker built with Hono and served at
`https://discovery.gyblos.com`. It implements the wire contract in
[discovery.md](discovery.md#running-an-index-wire-contract), which the
`@gyblos/discovery-http` client follows. Every record check goes through
`@gyblos/protocol` (`parsePublicV2`, `validatePublicV2Time`, `controlVerify` and
`verifyPublicV2`); the app keeps no copy of the record rules.

This page is the contributor reference: endpoints, publish modes, security
model, caching, uptime, seller GitHub claims and storage. Deploying the Worker,
applying remote migrations, changing its secrets and issuing invite codes are
maintainer procedures kept outside the repository, and each needs founder
approval.

## Endpoints

Routes sit at the root of the index host. The client base URL is
`https://discovery.gyblos.com/v1` (`DISCOVERY_INDEX_URL` in `@gyblos/config`).

| Route                              | Purpose                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /v1/records`                 | Publish one signed public v2 catalog, presence or withdrawal.                                                 |
| `GET /v1/sellers`                  | List live sellers of one model, paged by an opaque cursor.                                                    |
| `GET /v1/models`                   | List models from live sellers, ordered by seller count; no query parameters.                                  |
| `GET /v1/models/catalog`           | The same list with each model's `family`, `lab`, `source` and `categories` ([Model catalog](#model-catalog)). |
| `GET /v1/uptime?node=`             | Public uptime of one NodeId over the last day, week and month ([Uptime](#uptime)).                            |
| `GET /v1/versions[?node=<NodeId>]` | Active seller counts by release, or one active seller’s declared release.                                     |
| `GET /v1/network`                  | Every known seller, online, offline or unpublished, with counts ([Network](#network)).                        |
| `GET /v1/network/history`          | Average and peak sellers online per UTC day ([Network history](#network-history)).                            |
| `GET /v1/offers/history`           | Catalog periods and their exact prices, by NodeId or model ([Offer history](#offer-history)).                 |
| `GET /v1/health`                   | `{ ok: true, records, publish }`: unexpired record count and [publish mode](#publish-modes).                  |
| `POST /v1/registrations`           | Trade an invite code for publishing, once the NodeId is bound in the 8004 agent registry.                     |
| `POST /v1/identity/github`         | Submit a node-signed GitHub claim; the index checks its gist ([GitHub claims](#github-claims)).               |
| `GET /v1/identity/github/<NodeId>` | One seller's GitHub claim and the state of its last check.                                                    |
| `POST /v1/profile`                 | Set or clear a seller's node-signed display name ([Seller names](#seller-names)).                             |
| `GET /v1/profile/<NodeId>`         | One seller's display name, with its signed claim.                                                             |

Common behavior:

- **HTTPS only.** A request whose URL is not `https` gets
  `400 {"error":"HTTPS_REQUIRED"}` for every method and path, before storage or
  any rate limit. There is no redirect, so a `POST` body sent over `http` is
  never replayed. The check reads the scheme the client used; it needs no
  `CF-Visitor` header.
- **Unknown routes** answer `404 {"error":"NOT_FOUND"}`.
- **Headers.** Every response carries `X-Robots-Tag: noindex` and
  `X-Content-Type-Options: nosniff`. `GET` and `HEAD` on `/v1/sellers`,
  `/v1/models`, `/v1/models/catalog`, `/v1/uptime`, `/v1/versions`,
  `/v1/network`, `/v1/network/history`, `/v1/offers/history`, `/v1/health`,
  `/v1/identity/github/<NodeId>` and `/v1/profile/<NodeId>` carry
  `Access-Control-Allow-Origin: *` on every status, errors included. A `200`
  from `/v1/sellers`, `/v1/models`, `/v1/models/catalog`, `/v1/uptime`,
  `/v1/versions`, `/v1/network`, `/v1/network/history`, `/v1/offers/history`,
  `/v1/identity/github/<NodeId>` or `/v1/profile/<NodeId>` carries
  `Cache-Control: public, max-age=10`; everything else carries
  `Cache-Control: no-store`.

## Publish modes

Reads are always public. Who may publish depends on two inputs: the optional
Worker secret `DISCOVERY_PUBLISH_ALLOWLIST` and whether the `DISCOVERY_DB`
database is bound (registrations live there). `/v1/health` reports the mode in
`publish`, never the NodeIds.

| Mode         | When                                       | Who may publish                                                    | Others get                  |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------ | --------------------------- |
| `registered` | No usable allowlist secret, database bound | NodeIds admitted through `POST /v1/registrations`                  | `403 PUBLISH_NOT_ALLOWED`   |
| `allowlist`  | The secret lists NodeIds                   | Listed NodeIds, plus registered NodeIds when the database is bound | `403 PUBLISH_NOT_ALLOWED`   |
| `open`       | The secret is exactly `*`                  | Any NodeId with a valid self-signature                             | (none)                      |
| `closed`     | No usable allowlist secret and no database | Nobody: `POST /v1/records` answers `503` before the body is read   | `503 DISCOVERY_UNAVAILABLE` |

The deployed Worker always binds the database, so in production the mode is
`registered` unless an allowlist secret is set. Deleting the allowlist secret
therefore does not stop publishing: registered NodeIds keep publishing.

The allowlist secret holds comma-separated lowercase 64-hex NodeIds, at most
1,000 (Cloudflare's 5 KB secret limit allows fewer in practice). Whitespace
around commas is ignored and duplicates collapse. A missing or empty value, or
any malformed entry (uppercase, wrong length, an empty item such as a trailing
comma, `*` mixed with NodeIds, too many entries), counts as no allowlist.
NodeIds are public keys; the list is a secret only so that it lives outside the
repository and changes without a commit. It is never logged or returned.

Admission is a cheap check on the claimed `nodeId`, before the signature:

1. An allowlisted NodeId is accepted without reading the registration tables.
   Revoking a NodeId therefore has no effect while it stays on the allowlist.
2. Otherwise, with the database bound, the index reads whether the NodeId's
   registration is `active`.
3. A refused NodeId gets `403 PUBLISH_NOT_ALLOWED` before signature
   verification, any record storage read and the per-NodeId limit, so it
   consumes no NodeId allowance.

An admitted NodeId continues through the full path (signature, stale check,
per-NodeId limit, references, caps), so the signature still proves the claim.
Registered NodeIds count toward `maxNodes` like any other.

`createDiscoveryIndex` takes the parsed allowlist as `publishers`
(`{ mode: 'open' }`, `{ mode: 'allowlist', nodeIds }` or undefined) and the
registration store as `registrations`. The Worker parses the secret once per
isolate.

## Beta registration (invites)

A seller is admitted with a one-use invite code:

1. The seller registers its NodeId in the 8004 agent registry, paying with its
   own wallet.
2. The seller sends the invite code with `gyblos seller register` (see
   [running-a-node.md](running-a-node.md#seller-registration-beta-invite)). The
   client posts `{"invite":"gyb_<26 base32>","nodeId":"<64 hex>"}` to
   `POST /v1/registrations` (JSON, at most 512 bytes).
3. The index reads the registry itself and stores the NodeId as `active`.

The index checks the request in this order:

1. Per-IP and publish rate limits, then content type, size and strict shape. A
   malformed request is `400 INVALID_REGISTRATION`.
2. The invite code. An unknown, expired or spent code is `403 INVITE_INVALID`,
   before the chain is read. This route never says whether a NodeId is
   registered; `GET /v1/network` lists the active ones publicly
   ([Network](#network)).
3. A retry with the code that already admitted this NodeId answers
   `200 {"ok":true,"status":"active"}`, or `403 NODE_REVOKED` once revoked,
   without reading the chain.
4. The registry, through the RPC secret. No binding for the NodeId is
   `403 IDENTITY_NOT_REGISTERED`. An RPC outage, or a binding for another
   NodeId, is `503 DISCOVERY_UNAVAILABLE`.
5. A NodeId already active answers `200`; a revoked one `403 NODE_REVOKED`.
6. Success spends the code: `201 {"ok":true,"status":"active"}`.

Steps 3 to 5 do not spend the code. A holder of a usable code can therefore
learn whether a NodeId bound on chain is revoked until the code is spent or
expires, at one RPC read per request, limited per IP.

What the index stores (migration `0003_registrations.sql`):

- for the invite code: its SHA-256 (never the code), the contact it was issued
  to, its creation, expiry and use times, and the NodeId it admitted;
- for the NodeId: the owner and asset the registry bound (read from the chain,
  not the request), `active` or `revoked`, and the two-letter country Cloudflare
  derives from the request IP, when present. The country can be joined to the
  invite's contact.

No IP address or IP fingerprint is stored.

The index has no admin route. Maintainers issue invite codes (valid 14 days by
default, 1 to 90), revoke NodeIds and readmit them with
`apps/discovery-index/scripts/admin.ts` (`pnpm index:invite`,
`pnpm index:revoke`, `pnpm index:restore`), which write to the remote database
through Wrangler. A revoked NodeId's publishes and registrations are refused; an
invite code never readmits it. `--dry-run` prints the compiled SQL without
running anything.

Registration needs two more pieces of configuration:

- **RPC secret:** `DISCOVERY_SOLANA_RPC_URL`, a devnet RPC URL. The reader
  refuses query strings, so a provider key must be in the URL path; a
  `?api-key=` URL is refused. Without the secret, `/v1/registrations` answers
  `503`. The public `api.devnet.solana.com` answers `403` to Workers.
- **Workers runtime:** the reader comes from `@gyblos/identity`, which pulls
  `@gyblos/config`. The Worker sets `nodejs_compat` for its Node path helpers,
  and maps the reader's `redirect: 'error'` (unsupported on Workers) to
  `manual`, so a redirect is refused as a non-OK response.

## Security model and limits

The index is an untrusted cache. Acceptance proves only that the NodeId key
signed a record; clients re-verify everything.

- **Fail closed.** Without the `DISCOVERY_DB` binding or any of the three
  rate-limit bindings, every route answers `503 DISCOVERY_UNAVAILABLE`, as does
  any storage failure. Errors are static codes; input is never echoed and
  nothing is logged.
- **Development relaxation.** `createDiscoveryIndex({ development: true })`
  replaces missing limiters with in-memory counters (120 accepted records per
  NodeId per minute) and accepts `http`, only for requests to a loopback host.
  It never relaxes storage or publish admission. The Worker entry
  (`src/worker.ts`) always passes `development: false`, so a local
  `wrangler dev` needs `--local-protocol https`.
- **Publish order.** Per-IP limit, the 34,816-byte body cap (`413`), publish
  limit, content type, strict JSON, the admission check on the claimed NodeId
  (`403`), then shape, lifetime and the self-signature. Only then is the stored
  high-water mark checked: stale replays are `409`. Catalog references follow,
  then one atomic write checks freshness, the current catalog, capacity and the
  NodeId allowance together. Invalid references are `400` without spending
  allowance; a full NodeId budget is `429` without advancing the sequence.
- **Strict JSON.** Invalid UTF-8, a BOM, duplicate members, nesting deeper than
  16, non-canonical or unsafe numbers, `-0` and bad escapes are
  `400 INVALID_RECORD`. Post the signed envelope compact (no padding, no
  needless escapes); it is stored and served byte-for-byte as posted.
- **Sequence and references.** One high-water mark per NodeId, shared by all
  three kinds, kept for one maximum catalog lifetime past the record's expiry.
  Presence and withdrawal must reference the NodeId's current, live,
  non-withdrawn catalog under `verifyPublicV2` reference rules, else
  `UNKNOWN_CATALOG`. A withdrawal hides the seller until a higher catalog
  arrives. An expired withdrawal stays effective until its catalog expires or is
  replaced.
- **Capacity.** At most 10,000 tracked NodeIds; a new NodeId beyond that is
  `429`. Capacity and the current catalog are checked in the same atomic write
  as the high-water update. Expired rows are pruned when a new NodeId publishes,
  at most once a minute per isolate. In open mode, distributed publishers can
  fill and renew these slots and block new sellers: the cap bounds current
  records, not the [offer history](#offer-history), which grows with every
  distinct catalog until its retention ends; it is not Sybil resistance.
- **Privacy.** No IP address, header, session or request metadata is stored or
  logged; rate-limit keys go only to Cloudflare limiters.

Rate limits:

| Limit                               | Key                                     | Budget                                   | Consumed by                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCOVERY_IP_LIMITER`              | client IPv4 address, or IPv6 /64 prefix | set in `wrangler.jsonc`                  | every request                                                                                                                                                                                        |
| `DISCOVERY_PUBLISH_LIMITER`         | client IPv4 address, or IPv6 /64 prefix | set in `wrangler.jsonc`                  | publishes and registrations                                                                                                                                                                          |
| `DISCOVERY_READ_LIMITER`            | constant key `global`                   | set in `wrangler.jsonc`                  | storage reads only: a `/v1/sellers`, `/v1/models`, `/v1/models/catalog`, `/v1/uptime`, `/v1/versions`, `/v1/network`, `/v1/network/history` or `/v1/offers/history` cache miss, a stale health count |
| NodeId publish quota (stored in D1) | NodeId                                  | 10 accepted records per fixed UTC minute | accepted records only                                                                                                                                                                                |

- A Cloudflare limiter that refuses or fails gives `429 RATE_LIMITED` with
  `Retry-After: 60`. That `429` is `no-store` and never cached.
- Cloudflare counts rate limits per location, so the read cap is per location,
  not worldwide. Any well-formed cursor, `limit` or `model` misses the cache, so
  a few clients at one location can spend its budget; the other clients there
  then get `429` on uncached pages for up to 60 seconds while cached pages keep
  serving.
- The NodeId quota is shared across isolates and locations. Its counter advances
  atomically with the high-water mark; rejected, stale and concurrent duplicate
  records consume nothing, and delayed requests cannot move its window
  backwards.

## Caching

- **Public reads.** `/v1/sellers`, `/v1/models`, `/v1/models/catalog`,
  `/v1/uptime`, `/v1/versions`, `/v1/network`, `/v1/network/history`,
  `/v1/offers/history`, `/v1/identity/github/<NodeId>` and
  `/v1/profile/<NodeId>` keep `200` answers in the Workers Cache API
  (`caches.default`, per Cloudflare location) for 10 seconds, matching their
  `max-age`. Keys are normalized:
  - sellers: `cursor`, the effective `limit` (so `limit=5000` and `limit=200`
    share an entry) and `model`, in that order;
  - models, model catalog and network: the route alone;
  - uptime: `?node=<NodeId>`, however the query was spelled;
  - network history: the effective `days`;
  - offer history: `?node=<NodeId>` or `?model=<model>`, then the effective
    `days`;
  - GitHub claims: the route and the NodeId. A claim's new state can therefore
    take up to 10 seconds to show at a location that cached the old one.
  - seller names: the route and the NodeId. A new or cleared name can take up to
    10 seconds to show at a location that cached the old answer; the CLI says so
    when it sets a name.

  Invalid queries are rejected before the cache. Errors and publishes are never
  cached. Cached answers get the same CORS, `noindex` and `nosniff` headers as
  fresh ones. A cache failure falls back to storage.
  `createDiscoveryIndex({ cache })` takes any object with `match(key)` and
  `put(key, response)`; without it there is no response cache.

- **Health.** Each isolate reuses its `records` count for 30 seconds and counts
  again after it accepts a publish. `publish` always reflects the current mode.

## Uptime

Public seller uptime comes only from records the index already verified. Each
UTC hour has one row per NodeId (`migrations/0004_uptime.sql`) with one bit per
five-minute slot in which the index accepted a signed presence from that NodeId,
by the index's own clock. Catalogs and withdrawals do not count.

`GET /v1/uptime?node=<64 lowercase hex>` answers:

```json
{
  "nodeId": "…",
  "firstSeenAt": 1762473600000,
  "lastSeenAt": 1763078400000,
  "slotMs": 300000,
  "windows": [
    { "days": 1, "seen": 286, "slots": 288, "ratio": 0.9931 },
    { "days": 7, "seen": 2001, "slots": 2016, "ratio": 0.9926 },
    { "days": 30, "seen": 2002, "slots": 2017, "ratio": 0.9926 }
  ],
  "generatedAt": 1763078400000
}
```

- `firstSeenAt` is the earliest presence recorded for the NodeId. A separate row
  per NodeId (`discovery_uptime_nodes`) outlives the hourly rows, so a seller
  back after a long absence is not reported as new, and the absence counts in
  every window.
- `lastSeenAt` is the last recorded presence at five-minute resolution, or
  `null` when none falls within the last 30 days.
- `seen` counts slots with a presence; `slots` counts the window's slots up to
  and including the current one. A full day is 288 slots, so a seller online all
  day reports `1`. A window starts no earlier than `firstSeenAt`.
- A NodeId never seen is `404 NOT_FOUND`. A malformed or repeated `node`, or any
  other parameter, is `400 INVALID_QUERY`.

Uptime says a seller was reachable through the index; it doesn't say its answers
were correct or fast, and it doesn't measure direct or relay transport quality.

Implementation rules:

- Permanent uptime identities share the `maxNodes` capacity. At capacity,
  existing identities keep their history; new identities are left out of uptime
  (`404`) while their publication still succeeds. The capacity check and the
  first-sighting and hourly writes are one D1 transaction.
- Each app instance reserves a NodeId's slot before storage work, so concurrent
  refreshes share the pending write, and writes a NodeId at most once per slot.
  The write is an idempotent bitwise OR.
- Uptime is best effort: a failed write still accepts the presence and releases
  the reservation, so a later presence can retry that slot. A failing uptime
  table never blocks a publish or a new NodeId.
- Reports read only the last 30 days, but rows are kept for
  `UPTIME.retentionDays` (about ten years) as network history. Older rows are
  pruned at most once an hour per app instance, on the next accepted presence.

Kept rows grow the shared D1 database by about 160 bytes per NodeId and hour, or
about 1.4 MB per always-online NodeId per year. At 1,000 online sellers that is
about 1.4 GB a year against the 10 GB D1 limit, and a full database fails every
write, publishes included. Before the database nears the limit, roll old hours
into daily rows or move history to its own database.

## Network

`GET /v1/network` lists every seller the index knows, so anyone can count the
network's online, offline and unpublished sellers. It takes no parameters (any
is `400 INVALID_QUERY`):

```json
{
  "counts": { "total": 3, "online": 1, "offline": 1, "unpublished": 1 },
  "nodes": [
    {
      "nodeId": "…",
      "state": "online",
      "firstSeenAt": 1762473600000,
      "lastSeenAt": 1763078400000,
      "models": ["qwen3-0.6b"],
      "github": {
        "account": "octo-cat",
        "gist": "0123456789abcdef0123456789abcdef"
      },
      "name": "Ada Lovelace"
    },
    {
      "nodeId": "…",
      "state": "offline",
      "firstSeenAt": 1762473600000,
      "lastSeenAt": 1762990000000,
      "models": [],
      "github": null,
      "name": null
    },
    {
      "nodeId": "…",
      "state": "unpublished",
      "firstSeenAt": null,
      "lastSeenAt": null,
      "models": [],
      "github": null,
      "name": null
    }
  ],
  "truncated": false,
  "generatedAt": 1763078400000
}
```

- **Who is listed.** Every active registration, and every NodeId the index
  accepted a presence from within the last 30 days (allowlisted or, in open
  mode, any publisher). Registered NodeIds are already public on chain, where
  the 8004 registry binds each one to its owner, so they are listed before they
  publish. A revoked NodeId is listed only while it is online, exactly as
  `/v1/sellers` lists it. The allowlist itself is not exposed: an allowlisted
  NodeId appears only once it publishes. Unpublishing does not remove a seller
  from this list: a registered one stays listed, and any other until 30 days
  after its last presence.
- **`state`.** `online`: a live presence references its live, non-withdrawn
  catalog, exactly as `/v1/sellers` would list it. `unpublished`: never seen, or
  its stored catalog is withdrawn (`unpublish`). The index keeps a withdrawn
  catalog only until it expires (at most one catalog lifetime); after that a
  seller seen before shows as `offline`. `offline`: seen before, with no live
  presence now.
- **Fields.** `firstSeenAt` and `lastSeenAt` are the [uptime](#uptime) sightings
  (`lastSeenAt` is `null` when none falls within the last 30 days). `models`
  lists the catalog's model ids while `online`, and is empty otherwise. `github`
  is `{ account, gist }` when the seller's [GitHub claim](#github-claims) is
  `verified`, so a client can link the proof gist, and `null` otherwise; a
  `pending` or `lost` claim is read only through
  `GET /v1/identity/github/<NodeId>`. If the claims read fails (for example
  before migration `0007` is applied), every `github` is `null`, `truncated` is
  `true` and the route still answers. `name` is the seller's
  [display name](#seller-names), or `null` when it has none; it is self-chosen
  and never verified. Names are read only for the NodeIds the page lists that
  the index still knows (an active registration or a stored catalog, the same
  rule as `GET /v1/profile/<NodeId>`); a seller listed only from its sightings
  shows `name: null`. If the names read fails (for example before migration
  `0009` is applied), every `name` is `null`, `truncated` is `true` and the
  route still answers. No owner, contact, country or IP is returned.
- **Order and size.** Online first, then by `lastSeenAt` (latest first), then by
  NodeId. `counts` cover every listed seller. The `nodes` list stops before the
  answer would exceed 1 MiB.
- **Bounds.** Each source (active and revoked registrations, sightings, stored
  catalogs, verified GitHub claims) is read up to `maxNodes` rows by NodeId, and
  online models up to 20,000 rows. `truncated` is `true` when the list stopped
  at the size limit or a source filled its cap, so sellers, counts or models may
  be incomplete.
- **Cost.** One cache miss reads each source once. A NodeId's last sighting is
  its newest hourly uptime row, one primary-key lookup per tracked NodeId.
- In open mode (`DISCOVERY_PUBLISH_ALLOWLIST="*"`) anyone can add entries by
  publishing from new NodeIds, as with uptime; the caps bound them, but the
  public counts are not Sybil resistant.

## Model catalog

`GET /v1/models/catalog` takes no parameters and returns the `/v1/models` list
(at most 500 models) with four more fields per model:

```json
{
  "models": [
    {
      "id": "qwen3-0.6b",
      "sellers": 2,
      "family": "qwen",
      "lab": "Alibaba · Qwen",
      "source": "registry",
      "categories": ["general", "reasoning"]
    }
  ],
  "generatedAt": 1764028800000
}
```

Without a registry entry, `family`, `lab` and `source` are read from the model
id itself (`@gyblos/protocol/model-family`), never from a seller's claim; rules
ignore case, and are never `null`. A known publisher (`meta-llama/Llama-3.1-8B`)
decides the family (`google/gemma-…` is `gemma`); otherwise the name does, with
or without a publisher (`unsloth/Qwen3-8B` and `qwen3-0.6b` are `qwen`). Those
carry `source: "rules"`. An id no rule knows has `family: "other"`, its
publisher as written as `lab` (`acme/foo-7b` gives `acme`, a bare id `Unknown`)
and `source: "fallback"`. `/v1/models` keeps its two fields, because released
buyers reject extra keys there.

A model with an entry in the operator's registry (`discovery_model_registry`)
takes its `family`, `lab` and `categories` from that entry instead, with
`source: "registry"`. Without one, `categories` is `[]`. Categories come from
one fixed list (`@gyblos/protocol/model-categories`): `general`, `coding`,
`agentic`, `reasoning`, `classification`, `extraction`, `embedding`,
`reranking`, `vision`, `speech-to-text`, `text-to-speech`, `translation`,
`moderation`, `image-generation`, `image-editing`, `image-upscaling`,
`video-generation`, `audio-generation` and `document-understanding`. They
describe the model, not a seller's offer: modalities, context, quantization and
price stay with each offer. A cache miss reads the registry rows of the listed
models once.

### Model registry

`pnpm index:models [--remote]`
(`apps/discovery-index/scripts/model-registry.ts`) lists the registry.
`pnpm index:models --set <model> --family <family> --lab <lab> --categories <a,b> --local|--remote`
adds or replaces an entry: `family` is one of the rule families or `other`,
`lab` has 1 to 64 characters, and every category must be in the list above.
`pnpm index:models --remove <model> --local|--remote` deletes one. Like the
other operator scripts, it compiles its SQL with Drizzle and runs it through
Wrangler; the index has no admin route.

`pnpm index:models --unclassified [--remote]` is the check for new models: it
lists every model in a catalog that has not expired and has no registry entry,
and exits with code 1 while any remain, so it can run on a schedule. A model the
rules recognize still counts until it has an entry, because only the registry
carries categories.

## Network history

`GET /v1/network/history?days=7|30|90` (default 7; any other value or parameter
is `400 INVALID_QUERY`) gives, for each UTC day oldest first, how many sellers
were online on average and at peak:

```json
{
  "days": 7,
  "slotMs": 300000,
  "history": [
    {
      "day": "2026-11-24",
      "state": "final",
      "averageOnline": 1.9861,
      "peak": 2,
      "nodeSlots": 572,
      "coveredSlots": 288,
      "expectedSlots": 288
    }
  ],
  "generatedAt": 1800000001000
}
```

- It is read from the [uptime](#uptime) rows, so it counts NodeIds with an
  accepted presence in each five-minute slot. That is close to, but not the same
  as, the online rule of `/v1/network`, which also needs a current catalog.
- `nodeSlots` is the sum over the day's slots of the NodeIds seen in each;
  `averageOnline` is `nodeSlots / expectedSlots`, rounded to four decimals, and
  `peak` is the most NodeIds seen in one slot.
- `state` is `final` for a past day already summarized, `partial` for today
  (counted live, `expectedSlots` is the slots so far, the current one included),
  and `pending` for a past day not summarized yet (every number but
  `expectedSlots` is `null`).
- `coveredSlots` counts the slots vouched for by the ten-minute cron, which
  writes a heartbeat (`discovery_index_heartbeat`, one row per hour with one bit
  per slot) for its own slot and the one before. It shows that the scheduled run
  happened, not that every request was served. An empty covered slot is a zero;
  an uncovered one is unknown. Days before the heartbeat was deployed have
  `coveredSlots: 0`.
- **Daily summary.** After its heartbeat, each cron run summarizes up to four
  missing past days of the last 90, newest first, into `discovery_network_days`
  (one row per day). A day is summarized by the first run at least 15 minutes
  after it ends, which is the 00:20 UTC run on schedule. The 00:00 run already
  vouches for the day's last slot, so a run up to 15 minutes late still lands
  before the summary, which is final. After a deploy, the 90 days fill in within
  about four hours.
- Failures log only the static codes `DISCOVERY_HEARTBEAT_FAILED` or
  `DISCOVERY_NETWORK_ROLLUP_FAILED`. Heartbeat and summary rows are pruned with
  the uptime rows, after them, so a missing table never stops uptime pruning.
- **Cost.** One cache miss reads at most 90 summary rows, plus today's uptime
  rows (one per NodeId and hour seen today) and at most 24 heartbeat rows. A
  cron run reads the same for at most four past days.

## Offer history

The index keeps every catalog it accepts as a validity period, so a seller's
past prices stay traceable after it republishes, withdraws or leaves.

- **Periods.** The first accepted catalog of a NodeId opens a period. A later
  catalog with the same models, prices and owner, accepted before the open one
  expires, extends it (`lastSequence`, `lastPublishedAt`, `expiresAt`). Any
  other catalog closes it with `endReason: "replaced"` at the index's clock and
  opens a new one; a catalog that arrives after the open one expired closes it
  with `"expired"` at its expiry. A withdrawal closes it with `"withdrawn"`. A
  presence never touches the history: accepting a catalog clears the presence,
  but the period stays open. Times follow the index's clock but never move
  backwards for one NodeId: a period ends no earlier than its last renewal, and
  the next one starts no earlier than that end, and neither passes the signed
  `expiresAt`.
- **Writes.** The period and its offers are written in the publish batch, under
  the same high-water guard as the record, so a replayed or rejected record
  writes nothing, and neither does a second copy of an accepted record. Offers
  are stored once per distinct content (a SHA-256 of the catalog's `models`
  sorted by model, variant and quantization, so reordering them renews the
  period), one row per offer with its exact atomic prices, `unit`, network and
  asset. A renewal checks one offer key and the open period and updates only the
  period; a change also writes the new content's offer rows, all of them even
  when one price changed.
- **Retention.** Periods and their offers are kept for about ten years after
  they end (`OFFER_HISTORY.retentionDays`, the same as uptime), then dropped
  with the other expired rows; offer rows go once no kept period uses them.
- **History starts at the deploy.** Earlier catalogs were overwritten and are
  unknown. Sellers republish at least every 10 minutes, so every listed seller
  has a period within 10 minutes of the deploy.

`GET /v1/offers/history?node=<NodeId>` or `?model=<model>` (exactly one), with
an optional `days` from 1 to 92 (default 30), returns the periods that were
still valid during the last `days`, newest first:

```json
{
  "node": "<NodeId>",
  "days": 30,
  "from": 1797408001000,
  "periods": [
    {
      "nodeId": "<NodeId>",
      "owner": "<owner address>",
      "firstSequence": 12,
      "lastSequence": 40,
      "startedAt": 1799990000000,
      "lastPublishedAt": 1799999000000,
      "expiresAt": 1800000200000,
      "endedAt": null,
      "endReason": null,
      "offers": [
        {
          "modelId": "qwen3-0.6b",
          "variant": null,
          "quantization": "Q4_K_M",
          "contextTokens": 2048,
          "reasoning": ["off"],
          "pricing": {
            "inputAtomicPerMtok": "0",
            "outputAtomicPerMtok": "2",
            "unit": "million-tokens",
            "network": "<CAIP-2 network>",
            "asset": "<mint>"
          }
        }
      ]
    }
  ],
  "truncated": false,
  "generatedAt": 1800000001000
}
```

- A model query returns the periods of every seller that listed the model, with
  only that model's offers.
- An open period whose `expiresAt` has passed means the seller stopped
  republishing without a withdrawal.
- At most 50 periods per answer, and never more than the 1 MiB response cap;
  `truncated` says more existed. A missing, repeated or unknown parameter, or a
  `days` outside 1 to 92, answers `400 INVALID_QUERY`.

## GitHub claims

A seller can show which GitHub account runs it. The binding has two halves:

1. a claim signed by the node key: "my GitHub account is `account`, and gist
   `gist` proves it" (the [identity claim](identity.md#github-account-claim) in
   `@gyblos/protocol/identity-claim`);
2. a gist owned by that account with a file named `gyblos-proof.txt` that
   contains, on a line of its own, `gyblos-node=<NodeId>`.

An unlisted (secret) gist is accepted by design: GitHub serves its raw file the
same way, and the index publishes the gist id, so the proof is public either
way.

The claim is a separate message. It is never part of a public record, so record
parsers and older nodes are unaffected. The index checks its signature on
submission but does not keep or serve it: anyone can re-check the gist half from
the published account and gist, not the signature half.

**Trust only `verified`.** A client must treat an account as proven only when
`state === 'verified'`. `pending` and `lost` accounts are unproven claims by the
node. A verified claim proves that the GitHub account and the node key agreed at
the last check; it says nothing about the code the seller runs, the quality of
its answers or who controls the account later.

**Ownership check.** The index reads
`https://gist.githubusercontent.com/<account>/<gist>/raw/gyblos-proof.txt` (only
that file, so a gist with several files works). GitHub answers that URL only
when `<account>` owns the gist; for any other account name it answers `404`. The
account name is matched case-insensitively, and claims carry it lowercase. The
index therefore needs no GitHub API call or token. It follows no redirect, waits
at most 3 seconds and reads at most the first 16 KiB; a line cut at that bound
never counts.

### Submitting a claim

`POST /v1/identity/github` takes `{"claim":{…},"signature":"<128 hex>"}` (JSON,
at most 1024 bytes). The index checks, in this order:

1. Per-IP and publish rate limits (`429 RATE_LIMITED`), then content type, size
   (`413 PAYLOAD_TOO_LARGE`) and the strict claim shape (`400 INVALID_CLAIM`).
2. The node signature over the claim (`400 INVALID_SIGNATURE`).
3. `issuedAt`: at most 5 seconds ahead of the index's clock
   (`400 INVALID_CLAIM`) and at most 60 seconds old (`409 STALE_CLAIM`).
4. `issuedAt` must be newer than the stored claim's or cancel's
   (`409 STALE_CLAIM`), so a signed claim cannot be replayed.
5. A new binding needs a seller the index knows: an active registration or a
   stored catalog. Any other is `403 UNKNOWN_NODE`. A cancel does not, so a
   NodeId the index no longer knows can still withdraw its claim.

A cancel (`account` and `gist` both `null`) replaces the claim with a tombstone
that keeps only the NodeId, `issuedAt` and `last_fetch_at`, and answers
`200 {"ok":true,"state":null,"reason":null}`. A cancel from a NodeId with
nothing stored that the index does not know writes nothing. Any other claim is
stored and its gist checked at once:
`200 {"ok":true,"state":"verified","reason":null}`. The answer's `reason` is the
stored one after the check (see [States](#states)). Re-posting the same account
and gist keeps the stored state; a new account or gist starts over as `pending`.

POSTs fetch a NodeId's gist at most once a minute. The slot is reserved
atomically in storage (`last_fetch_at`, kept across claims and cancels), because
the index's rate-limit bindings count per IP, not per NodeId, and the publish
quota belongs to records. A claim posted inside that minute is stored without a
check and answers
`200 {"ok":true,"state":"<stored>","reason":"CHECK_DEFERRED","retryAfter":<seconds>}`.
`retryAfter` is when a new POST may fetch again; the stored claim is also due
for the next scheduled run, at most 10 minutes later.

Without the claims store or fetcher (no D1 binding) both claim routes answer
`503 DISCOVERY_UNAVAILABLE`.

### States

| Check outcome                                                        | Outcome code         | New state                                                     |
| -------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| Proof line found                                                     | none                 | `verified`; `verifiedAt` is set when a verified streak begins |
| Any status but `200`, `403`, `429`, `451` or `5xx`, redirects too    | `GIST_NOT_FOUND`     | `lost` if this binding was ever verified, else `pending`      |
| `200` without the proof line                                         | `NODE_ID_MISSING`    | `lost` if this binding was ever verified, else `pending`      |
| `403`, `429`, `451`, `5xx`, a timeout or a network error (an outage) | `GITHUB_UNAVAILABLE` | Unchanged; `checkedAt` moves                                  |

A redirect, such as the one a renamed account leaves, counts as not found, so
the claim turns `lost`. `403` and `429` are GitHub limiting the index, and `451`
is a legal block that may apply only where the request ran, so all three are
outages rather than evidence.

The stored `reason`, which the GET and POST answers carry, follows the state: it
is `null` while `verified` (an outage never shows a reason on a verified claim);
`GIST_NOT_FOUND` or `NODE_ID_MISSING` after a conclusive miss; and
`GITHUB_UNAVAILABLE` only when an outage hits a `pending` claim. A `lost` claim
keeps its miss reason through an outage. A check records only onto the claim it
started for. A conclusive result is written only while no other conclusive
result landed since the row it was computed from (an internal `verdict_at`
version that inconclusive checks never change), so a result from an older
snapshot never replaces a newer one and an earlier timeout never blocks it; an
inconclusive result only moves `checkedAt` forward (and sets the pending
reason), never the state or `verifiedAt`.

### Reading a claim

`GET /v1/identity/github/<NodeId>` (lowercase NodeId, no query string; anything
else is `400 INVALID_QUERY`) answers:

```json
{
  "nodeId": "…",
  "account": "octo-cat",
  "gist": "0123456789abcdef0123456789abcdef",
  "state": "verified",
  "reason": null,
  "checkedAt": 1763078400000,
  "verifiedAt": 1763078400000,
  "issuedAt": 1763078399000,
  "signature": "…"
}
```

`checkedAt` is the last check attempt, including one where GitHub did not
answer; `verifiedAt` is when the latest verified run began; it is kept after the
claim turns `lost` and is `null` if the claim was never verified.

`issuedAt` and `signature` are the stored claim's time and the node's hex
Ed25519 signature over it, so anyone can rebuild the `IdentityClaimV1`
(`schemaVersion` 1, `kind` `github`, with `nodeId`, `account`, `gist` and
`issuedAt` from this answer) and check it, wrapped as `{ claim, signature }`,
with `verifyIdentityClaim` instead of trusting the index. The index serves a
signature only after checking it against the served claim; `signature` is `null`
otherwise: a claim stored before migration `0008_claim_signature`, or one a
Worker from before that migration rewrote after a rollback. The seller's next
claim fills it, and a cancel written by such a Worker still reads as cancelled.

A NodeId without a claim, or whose claim was cancelled, is `404 NOT_FOUND`.
`/v1/network` carries the account and gist of every verified claim
([Network](#network)).

### Recheck

The Worker's cron trigger (`*/10 * * * *` in `wrangler.jsonc`) runs one bounded
batch: at most 25 claims whose next check is due, earliest first, one gist at a
time. A check schedules the next one 6 hours later. A claim still `pending` and
never verified 7 days after its `issuedAt` is no longer scheduled; it stays
readable, and a new POST (a newer `issuedAt`) checks it again. A storage
failure, such as a missing table, ends the run and logs the single static line
`DISCOVERY_GITHUB_RECHECK_FAILED` (no request, IP or claim data); every write is
conditional, so nothing stored is lost. A malformed row is unscheduled and
skipped, so it never blocks the batch.

### Operator view

`pnpm index:github-claims [--state pending|verified|lost] [--remote]`
(`apps/discovery-index/scripts/github-claims.ts`) lists claims, without
tombstones: NodeId, account, gist, state, reason, `issuedAt` and `checkedAt`,
newest first within each state, at most 1000 rows. It is read-only and runs
`wrangler d1 execute --json` (through npm's npx script under the same Node.js,
so it works the same on Windows, macOS and Linux; on macOS and Linux without npm
beside Node.js it uses `npx` on `PATH`, still without a shell; a failed launch
or run reports a static error, never the command line or its SQL, while
Wrangler's own messages still reach the terminal and may quote the statement)
against the local database, or the remote one with `--remote` (a maintainer
action).

### What is stored

Table `discovery_github_claims` (migration `0007_github_claims.sql`), one row
per NodeId: `node_id`, `account`, `gist`, `issued_at`, `state` (`pending`,
`verified` or `lost`), `reason`, `checked_at`, `verdict_at`, `verified_at`,
`last_fetch_at` and `next_check_at` (indexed). A tombstone keeps `node_id`,
`issued_at` and `last_fetch_at`, with every other column `NULL`. The signature
is checked and not kept. No IP or request data is stored or logged.

## Seller names

A seller may choose a public display name with `gyblos seller name "<name>"`
([running-a-node.md](running-a-node.md#seller-display-name)). The name is not
verified and not unique: any seller can pick any name the rule allows, including
another seller's. Only a `verified` [GitHub claim](#github-claims) says who runs
a seller, so a client must never show a name as verified or give it a check
mark. The name is a separate node-signed message (the
[profile claim](../packages/protocol/SPEC.md#profile-claim-v1) in
`@gyblos/protocol/profile-claim`); it is never part of a public record or offer,
so buyers and older nodes are unaffected.

The rule (`parseSellerName`, shared by the CLI, the index and the client) is
defined in the [profile claim](../packages/protocol/SPEC.md#profile-claim-v1).
In short: NFKC, typographic apostrophes made straight, spaces collapsed and
trimmed, 1 to 32 characters of letters, numbers, spaces and `-`, `_`, `.`, `'`,
with at least one letter or number. Accents and other combining marks are
allowed after a letter (at most 3 in a row), so names in Devanagari, Thai,
Arabic with harakat or Hebrew with niqqud can be spelled, but enclosing, overlay
and other decorative marks are not. Letters and non-ASCII digits must come from
the widely used scripts of UTS #31 and share one script, or mix Latin with Han
and Japanese kana, Korean Hangul or Bopomofo, so look-alike letters from another
script (Cyrillic, Greek, Lisu, Cherokee, Coptic) cannot be mixed in. Controls,
format and bidi characters, joiners (ZWNJ, ZWJ), invisible characters, emoji,
symbols (so no `✓` or `✅`), the middle dots `·` and `・`, modifier letters,
small capitals and check-like letters are refused, and so is any name whose
skeleton (case, separators, look-alike letters and digits ignored) contains
`gyblos`, `verified`, `verificado`, `official` or `oficial`.

`POST /v1/profile` takes
`{"claim":{"schemaVersion":1,"nodeId":"…","name":"…","issuedAt":…},"signature":"<128 hex>"}`
(JSON, at most 1024 bytes). It is checked like a
[GitHub claim](#submitting-a-claim), with the same codes: rate limits
(`429 RATE_LIMITED`), content type, size (`413 PAYLOAD_TOO_LARGE`) and the
strict claim shape, including a name already in the rule's form
(`400 INVALID_CLAIM`); the node signature (`400 INVALID_SIGNATURE`); `issuedAt`
at most 5 seconds ahead (`400 INVALID_CLAIM`), at most 60 seconds old and newer
than the stored name or clear (`409 STALE_CLAIM`); and, to set a name, a seller
the index knows (an active registration or a stored catalog; otherwise
`403 UNKNOWN_NODE`). A NodeId whose name an operator holds (see
[Removing a name](#removing-a-name)) gets `403 PROFILE_HELD`. It answers
`200 {"ok":true,"name":"Ada Lovelace"}`.

A clear (`"name": null`) replaces the name with a tombstone that keeps only the
NodeId and `issuedAt`, so an older signed name cannot be replayed, and answers
`200 {"ok":true,"name":null}`. Like a GitHub cancel, it needs no known seller,
and from a NodeId with nothing stored that the index does not know it writes
nothing. A clear from a NodeId whose name is held answers the same and changes
nothing.

`GET /v1/profile/<NodeId>` (lowercase NodeId, no query string; anything else is
`400 INVALID_QUERY`) answers
`{"nodeId":"…","name":"Ada Lovelace","issuedAt":1763078399000,"signature":"…"}`,
so anyone can rebuild the `ProfileClaimV1` and check it with
`verifyProfileClaim`. A NodeId without a name, whose name was cleared, or that
the index no longer knows (no active registration and no stored catalog, for
example after a revocation) is `404 NO_PROFILE`, a code an index without this
route never sends (its unknown routes answer `404 NOT_FOUND`). A NodeId whose
name an operator holds is `403 PROFILE_HELD`. `/v1/network` carries each
seller's `name` ([Network](#network)). Without the profile store (no D1 binding)
both routes answer `503 DISCOVERY_UNAVAILABLE`.

### Removing a name

`pnpm index:seller-profiles [--remote]`
(`apps/discovery-index/scripts/seller-profiles.ts`) lists stored names and held
NodeIds: NodeId, name, whether it is held and `issuedAt`, newest first, at most
1,000 rows; when it reaches that bound it says so. It reads the local database,
or the remote one with `--remote`.

`pnpm index:seller-profiles --hold <NodeId> --local|--remote` removes that
seller's name and keeps a held tombstone: the index then answers its GET with
`403 PROFILE_HELD` and refuses the seller's new names with the same code until
`pnpm index:seller-profiles --release <NodeId> --local|--remote`, which keeps
the tombstone's `issuedAt` so an older signed name still cannot be replayed.
Writes need an explicit `--local` or `--remote` (a maintainer action), and the
command prints which database it changed. It runs `wrangler d1 execute` like
`pnpm index:github-claims`.

### Stored names

Table `discovery_seller_profiles` (migration `0009_seller_profiles.sql`), one
row per NodeId: `node_id`, `name`, `issued_at`, `signature` and `held`; a
tombstone has `name` and `signature` `NULL`, and a held one has `held` 1. A
stored name outside the rule fails closed (`503`). No IP or request data is
stored or logged.

## Storage

- `src/storage.ts` defines the storage contract and an in-memory adapter for
  tests and local runs. `src/storage-d1.ts` is the D1 adapter, using Drizzle ORM
  (pinned in the app manifest).
- `src/schema.ts` declares every table, column, key, secondary index and check
  constraint, including registrations and uptime. Schema changes start there,
  and the migration is generated from it (see the migrations below); tests check
  its metadata against the migrations.
- `storage-queries.ts`, `storage-writes.ts`, `registration-queries.ts`,
  `uptime-d1.ts`, `github-claim-store-d1.ts` and `profile-store-d1.ts` build
  every query through Drizzle. `d1-client.ts` runs only ORM-generated statements
  and native transactional batches. The admin script uses the same schema and
  mutation builders, rendered through Drizzle's SQLite dialect because the
  Wrangler CLI takes SQL rather than bind parameters.
- A publish is one D1 batch (one transaction) that admits the high-water mark
  and NodeId quota together before writing the record. A failed batch rolls both
  back.
- Listing is two-phase. A `page` CTE walks `discovery_catalog_models_by_model`
  in NodeId order from the cursor (no sort) and filters and limits only keys,
  digests and times from covering indexes, then reads the signed JSON of the
  page rows by primary key, at most `limit + 1` catalog and presence blobs. The
  cursor is the last NodeId of the page.
- Writes update in place: catalog, presence and withdrawal rows are upserted
  under the high-water guard, and a catalog republish writes only the model ids
  that changed. Model insertion binds at most 68 parameters for 64 models, below
  [D1's limit of 100](https://developers.cloudflare.com/d1/platform/limits/).
  Offer history rows come from the catalog JSON through `json_each`, one bound
  value for up to 64 offers.

The only handwritten SQL expressions live in `src/sqlite-expressions.ts`:

| Expression               | Why Drizzle can't express it                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `INDEXED BY`             | No index-hint builder. Without it SQLite reads tables holding signed JSON before pagination; a key-only `EXPLAIN` test pins it. |
| `(VALUES (1))`           | The select builder needs a `FROM`; initial admission must still check capacity and references atomically on empty tables.       |
| Two-argument `min`/`max` | Drizzle's versions are aggregates; retention, quota windows and uptime sightings need the scalar form inside atomic updates.    |
| `coalesce`               | No builder; an inconclusive GitHub check moves `checked_at` forward from `NULL`, and a new offer period starts after the last.  |
| `CASE`                   | No conditional builder; quota resets, uptime admission and closing an expired offer period use it atomically.                   |
| `length`                 | No scalar builder; the schema keeps the database text-length checks.                                                            |
| Bitwise OR               | No bitwise builder; concurrent uptime observations combine slot bits in one write.                                              |
| `json_each`              | No builder; the network read matches names to the NodeIds it lists, and offer history rows come from one catalog JSON value.    |
| `json_extract`, `cast`   | No builder; each offer row's fields and position are read from that catalog JSON value inside the guarded insert.               |
| `NULL` select item       | The insert-select of a new offer period must name its still-empty end columns.                                                  |
| Scalar subquery          | No correlated subquery in a SELECT list; the network read takes each NodeId's newest uptime row by primary key.                 |

Migrations, applied in order:

| Migration                     | Adds                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `0001_discovery_index.sql`    | Record tables and their indexes.                                                        |
| `0002_listing_indexes.sql`    | Covering listing indexes (index-only; listing answers `503` without them).              |
| `0003_registrations.sql`      | Invite and registration tables.                                                         |
| `0004_uptime.sql`             | Uptime tables.                                                                          |
| `0005_node_publish_quota.sql` | The NodeId publish window and counter (publishing answers `503` without it).            |
| `0006_presence_version.sql`   | Current presence release and attested sequence. Apply before rolling out the new index. |
| `0007_github_claims.sql`      | Seller GitHub claims. Apply before deploying the claim routes and the cron trigger.     |
| `0008_claim_signature.sql`    | The node signature of each GitHub claim, served by its GET route.                       |
| `0009_seller_profiles.sql`    | Seller display names. Apply before deploying the profile routes.                        |
| `0010_offer_history.sql`      | Offer history. Apply before deploying it, or catalog publishes fail with `503`.         |

Migrations are generated with drizzle-kit from `src/schema.ts`
(`pnpm index:db:generate --name <change>`, configured in
`apps/discovery-index/drizzle.config.ts`); never write migration SQL by hand.
`0001`–`0007` were written by hand before drizzle-kit, are applied in production
and stay byte-for-byte unchanged. `migrations/meta/` holds drizzle-kit's journal
and snapshots. Its baseline, `0007_snapshot.json`, describes the schema after
`0007` and its journal entry names `0007_github_claims`; generated files start
at `0008`, and each new one takes the next number in the journal. Wrangler
applies `.sql` files only, records them by file name, and therefore applies only
the new ones.

Drizzle cannot declare the tables' `WITHOUT ROWID` layout, so tables created by
generated migrations are ordinary rowid tables. A change SQLite cannot make with
`ALTER TABLE` (for example making a column nullable) makes drizzle-kit rebuild a
baseline table as a rowid table; a test rejects that, and such a change needs a
founder decision first. Never run drizzle-kit `push`, `pull` or `introspect`
against the D1 database: they would rebuild every table the same way (the config
has no credentials). A data-only change (`UPDATE`, `DELETE`, backfill) is the
one exception to generated SQL:
`pnpm index:db:generate --custom --name <change>` creates the journaled file,
whose body holds only reviewed data statements.

Apply a migration before deploying code that needs it, and apply it to the
remote database only with founder approval. Each migration adds tables, columns
(with defaults) or indexes; `0002` also drops one unused index. The running
version therefore keeps working while a migration applies, and a code rollback
leaves the additions unused. Never edit an applied migration.

Tests run the same HTTP cases against the in-memory adapter and a `node:sqlite`
D1 double that applies every real migration in order
(`tests/support/d1-sqlite.ts`). They also check the listing query plan and count
written rows, so CI needs no Cloudflare account.

## Operations

Deploying, applying remote migrations, changing secrets, rolling back and
issuing invite codes for this service is a maintainer procedure kept outside the
repository. The resource names and bindings are in
`apps/discovery-index/wrangler.jsonc`. To check the deployed index:

```sh
curl -s https://discovery.gyblos.com/v1/health
```

The output is similar to the following:

```text
{"ok":true,"records":4,"publish":"registered"}
```

## Seller release declarations

A released seller adds the optional `Gyblos-Seller-Version` header to its
existing signed presence POST. Its value is the release, a colon and the hex
Ed25519 signature of the canonical object `{presenceSignature, version}` under
the domain `gyblos/seller-version/v1\n` (ending in a newline). The index
verifies the declaration with the presence's NodeId. It stores only the version
and matching presence sequence. Older readers receive the same signed envelopes,
and older index writers can still publish after migration. A heartbeat with an
absent or invalid proof gives an unknown version.

`GET /v1/versions` returns
`{active, unknown, versions: [{version, nodes}], truncated}`. Only unexpired,
non-withdrawn catalogs with matching live presence count. Version groups are
sorted by release string. The flag indicates the source or response cap was
reached. `GET /v1/versions?node=<NodeId>` returns `{nodeId, version}` (null for
an unknown release) or 404 when inactive. Both reads use the public cache and
read limits. These are current declarations, not a history or proof of binary
integrity.
