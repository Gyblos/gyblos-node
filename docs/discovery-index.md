# Discovery index Worker

`apps/discovery-index` (`@gyblos/discovery-index`) is the reference HTTP
discovery index: a Cloudflare Worker for `https://discovery.gyblos.com`, built
with Hono. It implements the wire contract in
[discovery.md](discovery.md#running-an-index-wire-contract), which the
`@gyblos/discovery-http` client follows. It moved here from the website so that
record verification has a single source: every record check goes through
`@gyblos/protocol` (`parsePublicV2`, `validatePublicV2Time`, `controlVerify` and
`verifyPublicV2`); the app keeps no copy of the record rules.

It is deployed at `https://discovery.gyblos.com` with the D1 database
`gyblos-discovery`. Changing Cloudflare resources, applying migrations to the
remote database and deploying are founder-approved manual steps (see
[Operations](#operations)).

## Endpoints

Routes sit at the root of the index host; the client base URL is
`https://discovery.gyblos.com/v1` (`DISCOVERY_INDEX_URL` in `@gyblos/config`).

| Route                    | Purpose                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `POST /v1/records`       | Publish one signed public v2 catalog, presence or withdrawal.                              |
| `GET /v1/sellers`        | List live sellers of one model, paged by an opaque cursor.                                 |
| `GET /v1/models`         | Every model live sellers list, with how many list it.                                      |
| `GET /v1/uptime?node=`   | Public uptime of one NodeId over the last day, week and month (below).                     |
| `GET /v1/health`         | `{ ok: true, records, publish }` (see below).                                              |
| `POST /v1/registrations` | Trade a beta invite for publishing, once the NodeId is bound in the 8004 registry (below). |

The index is HTTPS only: a request whose URL is not `https` gets
`400 {"error":"HTTPS_REQUIRED"}` for every method and path, before storage or
any rate limit is touched. There is deliberately no redirect, so a `POST` body
sent over plain `http` is never replayed and clients learn to fix their base
URL. The check reads the scheme of the request URL, which on Workers is the
scheme the client used; it needs no `CF-Visitor` header.

Anything else is a real `404 {"error":"NOT_FOUND"}`. Every response carries
`X-Robots-Tag: noindex`; responses other than `/v1/sellers` carry
`Cache-Control: no-store`. `GET`/`HEAD` on `/v1/sellers` and `/v1/health` carry
`Access-Control-Allow-Origin: *` on every status, errors included.

`records` in the health body is the count of unexpired records; `publish` is
`"closed"`, `"allowlist"`, `"registered"` or `"open"` (the publish mode, never
the listed or registered NodeIds). `publish` is a reference-index extension that
clients must not rely on.

## Publish allowlist (devnet)

Reads are public. During devnet only approved NodeIds may publish: the Worker
secret `DISCOVERY_PUBLISH_ALLOWLIST` holds them as comma-separated lowercase
64-hex NodeIds (whitespace around commas is ignored, duplicates collapse), at
most 1000 entries. The single value `*` opens publishing to any self-signed
NodeId, the permissionless design for later.

- **Without a usable secret:** if the secret is missing, empty, or has any
  malformed entry (uppercase, wrong length, an empty item such as a trailing
  comma, `*` mixed with NodeIds, more than 1000 entries), only NodeIds admitted
  through `POST /v1/registrations` may publish (health reports `registered`);
  every other NodeId gets `403 PUBLISH_NOT_ALLOWED`. Without storage either,
  every `POST /v1/records` answers `503 DISCOVERY_UNAVAILABLE` before the body
  is read. `GET /v1/sellers` and `GET /v1/health` keep working.
- **Allowlist first:** an allowlisted NodeId is accepted without reading the
  registration tables, so allowlisted sellers keep publishing before migration
  0003 is applied; until then any other NodeId gets `503` instead of `403`.
- **In production** D1 is always bound, so the mode is never `closed`: health
  reports `registered` even before the RPC secret is set (then
  `/v1/registrations` answers 503) or the migration is applied. Registered
  NodeIds count toward `maxNodes` like any other, so with registrations on the
  stored node count is always checked, allowlisted NodeIds included.
- **Cheap rejection:** after the per-IP and publish limits and the strict body
  checks, the record's claimed `nodeId` is looked up first. An unlisted NodeId
  gets `403 PUBLISH_NOT_ALLOWED` before signature verification, any storage read
  and the per-NodeId limit, so it consumes no NodeId allowance. A listed NodeId
  continues through the unchanged path (signature, stale check, per-NodeId
  limit, references, caps), so the claim is still proven by the signature.
- **Not secret, but a secret:** NodeIds are public keys. The list is kept as a
  Worker secret only so that it lives outside the repository and can change
  without a commit. It is never logged or returned; health shows the mode only.
- **Size:** Cloudflare caps one variable or secret at 5 KB, so in practice the
  list holds about 78 NodeIds (65 bytes each with the comma), well below the
  1000-entry cap.
- The Worker parses the secret once per isolate, with the app it caches.
  `createDiscoveryIndex` takes it as `publishers`: `{ mode: 'open' }`,
  `{ mode: 'allowlist', nodeIds }`, or undefined (closed).

## Beta registration (invites)

The beta replaces the allowlist with one-use invites (vault
`20 Decisions/Alta de vendedores.md` §2). The seller registers its NodeId in the
8004-solana registry, paying with its own wallet, then sends (with
`gyblos seller register`;
[running-a-node.md](running-a-node.md#seller-registration-beta-invite))
`POST /v1/registrations` with `{"invite":"gyb_<26 base32>","nodeId":"<64 hex>"}`
(JSON, at most 512 bytes).

- **Order of checks:** per-IP and publish limits, content type, size and strict
  shape (`400 INVALID_REGISTRATION`). The invite comes next, so without a usable
  invite (or the one that admitted that NodeId) nothing reveals whether a NodeId
  is registered: an unknown, expired or already spent invite is
  `403 INVITE_INVALID`, before the chain is read. A retry with the invite that
  already admitted this NodeId answers `200 {"ok":true,"status":"active"}`, or
  `403 NODE_REVOKED` once revoked, without reading the chain. Then the registry
  is read through the RPC secret: no binding for the NodeId is
  `403 IDENTITY_NOT_REGISTERED`; an RPC outage or a binding for another NodeId
  is `503 DISCOVERY_UNAVAILABLE`. A NodeId already active answers `200` and a
  revoked one `403 NODE_REVOKED`. None of these spends the invite, so a holder
  of a usable invite can learn the status of NodeIds bound on chain until it is
  spent or expires (one RPC read each, per-IP limited). Success is
  `201 {"ok":true,"status":"active"}`.
- **What is stored** (migration `0003_registrations.sql`): the invite's SHA-256
  (never the code), the contact it was issued to, its creation, expiry and use
  time and the NodeId it admitted; for the NodeId, the owner and asset the
  registry bound (from the chain, not the request), `active` or `revoked`, and
  the two-letter country Cloudflare derives from the request IP, when present
  (the vault decision; it is joinable to the invite's contact). No IP or IP
  fingerprint.
- **Invites and revocation** are founder commands that write to the remote D1
  through a Wrangler login; the index has no admin route:

  ```sh
  pnpm index:invite --contact seller@example.com   # prints a gyb_… code, valid 14 days (--days 1-90)
  pnpm index:revoke <NodeId>                       # its publishes and registrations are refused
  pnpm index:restore <NodeId>                      # readmits a revoked NodeId; invites never do
  ```

  Add `--dry-run` to print the SQL instead. The code is printed once and cannot
  be shown again.

- **RPC secret:** `DISCOVERY_SOLANA_RPC_URL`, a devnet RPC URL. The reader
  refuses query strings, so the provider key must be in the path (Alchemy- or
  QuickNode-style URLs; a `?api-key=` URL is refused). Without it the route
  answers 503. The public `api.devnet.solana.com` answers 403 to Workers.
- **Workers runtime:** the reader comes from `@gyblos/identity`, which pulls
  `@gyblos/config`; the Worker sets `nodejs_compat` for its Node path helpers,
  and maps the reader's `redirect: 'error'` (unsupported on Workers) to
  `manual`, so a redirect is refused as a non-OK response.

## Security model and limits

The index is an untrusted cache. Acceptance proves only that the NodeId key
signed a record; clients re-verify everything.

- **Fail closed:** without the `DISCOVERY_DB` binding or any of the four
  rate-limit bindings, every route answers `503 DISCOVERY_UNAVAILABLE`, as does
  any storage failure. Without a valid publish allowlist, only publishing is
  `503`. Errors are static codes; input is never echoed, and nothing is logged.
- **Development relaxation:** `createDiscoveryIndex({ development: true })`
  replaces missing limiters with in-memory counters and accepts plain `http`,
  only for requests to a loopback host, and never relaxes storage or the publish
  allowlist. The Worker entry (`src/worker.ts`) always passes
  `development: false`, so a local `wrangler dev` needs
  `--local-protocol https`.
- **Rate limits:** `DISCOVERY_IP_LIMITER` on every request and
  `DISCOVERY_PUBLISH_LIMITER` on publishes, keyed by client address (IPv4 by
  full address, IPv6 by its /64 prefix); `DISCOVERY_NODE_LIMITER` keyed by the
  verified NodeId, consumed only by records that would advance its high-water
  mark. A limiter that refuses or fails is `429 RATE_LIMITED` with
  `Retry-After: 60`.
- **Global read cap:** `DISCOVERY_READ_LIMITER` (300 per 60 seconds, constant
  key `global`) is consumed only by storage reads: a `GET /v1/sellers`,
  `/v1/models` or `/v1/uptime` cache miss and a `/v1/health` whose cached count
  is stale. Cache hits and fresh health counts never consume it, so many cursors
  or clients cannot multiply D1 reads past it. Cloudflare counts rate limits per
  location, so this is a cap per Cloudflare location, not an exact worldwide
  one; a Durable Object counter would be the exact alternative if that is ever
  needed. Any well-formed cursor, `limit` or `model` makes a cache miss, so a
  few clients at one location can spend its budget; the other clients there then
  get `429` on uncached pages for up to 60 seconds while cached pages keep
  serving. This is the accepted cost of one shared key. Its `429` is `no-store`
  and never enters the response cache. The per-IP limit still applies first to
  every request.
- **Publish order:** per-IP limit, the 34816-byte body cap (`413`), publish
  limit, content type, strict JSON, the allowlist check on the claimed NodeId
  (`403`), then shape, lifetime and the self-signature. Only then is the stored
  high-water mark checked: stale replays are `409` before the per-NodeId limit,
  so replaying a seller's records cannot exhaust its allowance, and unsigned
  junk never reaches that limit.
- **Strict JSON:** invalid UTF-8, a BOM, duplicate members, nesting deeper than
  16, non-canonical or unsafe numbers, `-0` and bad escapes are
  `400 INVALID_RECORD`. The signed envelope must be posted compact (no padding,
  no needless escapes) and is stored and served byte-for-byte as posted.
- **Sequence and references:** one high-water mark per NodeId shared by all
  three kinds, kept for one maximum catalog lifetime past the record's expiry.
  Presence and withdrawal must reference the NodeId's current, live,
  non-withdrawn stored catalog under `verifyPublicV2` reference rules, else
  `UNKNOWN_CATALOG`. A withdrawal hides the seller; only a higher catalog
  revives it.
- **Capacity:** at most 10,000 tracked NodeIds (new NodeIds beyond that are
  `429`). When publishing is an allowlist no larger than that cap, the list
  itself bounds new NodeIds and the count is skipped (NodeIds kept from an
  earlier list leave with their retention). Expired rows are pruned when a new
  NodeId publishes, at most once a minute per isolate, with index-only deletes.
- **Privacy:** no IP address, header, session or request metadata is stored or
  logged; rate-limit keys go only to Cloudflare limiters.

## Caching

- **Sellers pages:** `GET /v1/sellers` answers
  `Cache-Control: public, max-age=10`, and the Worker also keeps `200` pages in
  the Workers Cache API (`caches.default`, per Cloudflare location) for those 10
  seconds. The key is normalized from the parsed query: `cursor`, `limit` (the
  effective value, so `limit=5000` and `limit=200` share it) and `model`, in
  that order, on `/v1/sellers` of the request's origin. Invalid queries are
  rejected before the cache, and errors, publishes and health are never cached.
  CORS, `noindex` and `nosniff` headers are added to cached pages exactly as to
  fresh ones. A cache failure falls back to storage.
  `createDiscoveryIndex({ cache })` takes any object with `match(key)` and
  `put(key, response)`; without it there is no response cache.
- **Health:** each isolate reuses its `records` count for 30 seconds and counts
  again after it accepts a publish. `publish` always reflects the current mode.

## Uptime

Public seller uptime comes only from records the index already verified. Each
UTC hour has one row per NodeId (`migrations/0004_uptime.sql`) with one bit per
five-minute slot in which the index accepted a signed presence from that NodeId,
at the index's own clock. Catalogs and withdrawals do not count. Rows older than
30 days are pruned at most once an hour per app instance, on the next accepted
presence, separately from record pruning: retention holds even when no new
NodeId publishes, and a failing uptime table never blocks a publish or the
admission of a new NodeId.

`GET /v1/uptime?node=<64 lowercase hex>` answers

```json
{
  "nodeId": "…",
  "firstSeenAt": 1762992000000,
  "lastSeenAt": 1763078400000,
  "slotMs": 300000,
  "windows": [
    { "days": 1, "seen": 286, "slots": 288, "ratio": 0.9931 },
    { "days": 7, "seen": 2001, "slots": 2016, "ratio": 0.9926 },
    { "days": 30, "seen": 2001, "slots": 2017, "ratio": 0.9921 }
  ],
  "generatedAt": 1763078400000
}
```

`firstSeenAt` is the first presence the index ever accepted from the NodeId: one
row per NodeId (`discovery_uptime_nodes`) outlives the 30-day hourly rows, so a
seller back after a long absence is not reported as new and the absence counts
in every window. `lastSeenAt` is the last recorded presence, at five-minute
resolution (each app instance writes a NodeId once per slot), or `null` when
none falls within the last 30 days. `seen` counts slots with a presence and
`slots` counts the window's slots up to and including the current one: a full
day is 288 slots, so a seller online all day reports `1`. A window starts no
earlier than `firstSeenAt`, so a new seller is not counted down for time before
it existed. A NodeId never seen is `404 NOT_FOUND`; a malformed or repeated
`node`, or any other parameter, is `400 INVALID_QUERY`. Answers are cached and
CORS-readable like `/v1/models`, with one cache entry per NodeId however the
query is spelled.

Each app instance writes a NodeId's slot once, however often the seller
refreshes its presence, and the write is an idempotent bitwise OR. The write is
best effort: if it fails, the presence is still accepted and that slot simply
counts as offline. Uptime says a seller was reachable through the index; it does
not say its answers were correct or fast.

## Storage

`src/storage.ts` defines the storage contract and an in-memory adapter (tests
and local runs); `src/storage-d1.ts` is the D1 adapter, with minimal local D1
interfaces instead of `@cloudflare/workers-types`. A publish is one D1 batch
(one transaction) whose statements apply only if its high-water upsert won.

`migrations/0001_discovery_index.sql` creates the five tables and their indexes.
The website's draft `0001` and `0002` (prune indexes) were never applied to any
database, so they are combined into this one clean migration.
`migrations/0002_listing_indexes.sql` changes indexes only (idempotent
`CREATE INDEX IF NOT EXISTS` / `DROP INDEX IF EXISTS`): covering listing indexes
on catalogs `(node_id, digest, issued_at, expires_at)`, presence
`(node_id, catalog_digest, issued_at, expires_at)` and withdrawals
`(node_id, catalog_digest)`, and it drops the unused
`discovery_presence_by_issue`.

- **Listing is two-phase.** A `page` CTE filters, sorts and limits only keys,
  digests and times read from those covering indexes; the signed JSON of the
  page rows is then read by primary key. The sort never carries a blob, and a
  page reads at most `limit + 1` catalog and presence blobs. The query names the
  indexes with `INDEXED BY` (D1 may have no statistics to choose them), so
  `0002` must be applied before code that uses them is deployed; without it
  listing answers `503`.
- **Writes update in place.** Catalog, presence and withdrawal rows are upserted
  (`ON CONFLICT (node_id) DO UPDATE`) under the same high-water guard, and a
  catalog republish deletes and inserts only the model ids that changed, so an
  unchanged model list writes no model row.

Tests run the same HTTP cases against the in-memory adapter and a `node:sqlite`
D1 double that applies every real migration in order
(`tests/support/d1-sqlite.ts`), check the listing query plan and count written
rows; CI needs no Cloudflare account.

## Operations

Every step below needs explicit founder approval. Run from
`apps/discovery-index` after `pnpm install --frozen-lockfile` at the repository
root. Wrangler is not a workspace dependency (it would add a large toolchain to
the lockfile for a manual, rare step); use the version the website already pins:

```sh
npx wrangler@4.151.1 login   # pick the account that holds the gyblos.com zone
npx wrangler@4.151.1 d1 create gyblos-discovery
# put the printed database_id into wrangler.jsonc and uncomment d1_databases
npx wrangler@4.151.1 d1 migrations apply gyblos-discovery --remote
npx wrangler@4.151.1 d1 migrations list gyblos-discovery --remote   # 0001 applied
# rate-limit namespace ids 42621004-42621007 must not collide with the website's
# web/wrangler.jsonc (it uses 42621001-42621003); then uncomment ratelimits and
# routes (custom domain discovery.gyblos.com, zone gyblos.com in this account)
# deploy closed first: the Worker must exist before its secret is set
# (secret put on a missing Worker uploads an empty draft Worker, which would
# become the rollback target)
npx wrangler@4.151.1 deploy
curl -s https://discovery.gyblos.com/v1/health
# expected: 200 {"ok":true,"records":0,"publish":"closed"} (reads work,
# publishes answer 503)
# publish allowlist: paste comma-separated approved NodeIds at the prompt;
# this deploys a new version with the secret
npx wrangler@4.151.1 secret put DISCOVERY_PUBLISH_ALLOWLIST
curl -s https://discovery.gyblos.com/v1/health
# expected: "publish":"allowlist" (or "open" if the value was `*`)
curl -si https://discovery.gyblos.com/nope | grep -i x-robots-tag
# expected: 404 with noindex
curl -si 'https://discovery.gyblos.com/v1/sellers?model=x' | grep -i access-control
# expected: Access-Control-Allow-Origin: *
```

### Updating the deployed index

Apply new migrations before deploying the code that needs them (for `0002`, the
listing query names its indexes). Migration `0002` only adds and drops indexes,
so the running version keeps working while it applies:

```sh
npx wrangler@4.151.1 d1 migrations list gyblos-discovery --remote    # 0002 pending
npx wrangler@4.151.1 d1 migrations apply gyblos-discovery --remote
npx wrangler@4.151.1 d1 migrations list gyblos-discovery --remote    # nothing pending
npx wrangler@4.151.1 deploy
curl -s https://discovery.gyblos.com/v1/health
curl -s -o /dev/null -w '%{http_code}\n' 'https://discovery.gyblos.com/v1/sellers?model=x'
# expected: 200
curl -s http://discovery.gyblos.com/v1/health
# expected: 400 {"error":"HTTPS_REQUIRED"} (unless the zone's Always Use HTTPS
# redirects first; either way nothing is served over http)
```

For beta registration (migration `0003`, `nodejs_compat`, the RPC secret), apply
the migration first; it only adds tables, so the running version keeps working.
Keep the allowlist secret during the switch, so the allowlisted seller keeps
publishing, and remove it once that seller is registered:

```sh
npx wrangler@4.151.1 d1 migrations apply gyblos-discovery --remote   # 0003
npx wrangler@4.151.1 deploy
npx wrangler@4.151.1 secret put DISCOVERY_SOLANA_RPC_URL             # devnet URL, key in the path
curl -s https://discovery.gyblos.com/v1/health                       # "publish":"allowlist" while the secret stays
curl -s -X POST https://discovery.gyblos.com/v1/registrations \
  -H 'content-type: application/json' -d '{"invite":"gyb_aaaaaaaaaaaaaaaaaaaaaaaaaa","nodeId":"'"$(printf 'ab%.0s' $(seq 32))"'"}'
# expected: 403 {"error":"INVITE_INVALID"} (503 means the RPC secret is missing or refused)
```

Rolling that code back leaves the `0003` tables unused; nothing needs reverting.

Public uptime (migration `0004`) follows the same order: apply the migration,
then deploy. It only adds a table, so the running version keeps working, and
rolling the code back leaves the table unused.

```sh
npx wrangler@4.151.1 d1 migrations apply gyblos-discovery --remote   # 0004
npx wrangler@4.151.1 deploy
curl -s "https://discovery.gyblos.com/v1/uptime?node=<a live seller NodeId>"  # 200 after its next presence
```

The global read limiter (`DISCOVERY_READ_LIMITER`, namespace `42621007`) ships
in the same deploy as the code that requires it; deploying the code without the
binding answers `503` everywhere. After deploying it, check that sellers pages
still answer `200` and a repeat within 10 seconds is a cache hit. To roll it
back, `npx wrangler@4.151.1 rollback 916eb7c0` (the version before it, which has
neither the binding nor the code).

Rolling the code back does not require reverting `0002`: earlier code names no
index and no query used `discovery_presence_by_issue`.

Rollback: `npx wrangler@4.151.1 rollback` returns to the previous version (it
asks for confirmation when secrets changed since that version; decline unless
you mean to run the older code with the current secret); or comment out
`d1_databases` (or a rate limit) and deploy again; the index then answers
`503 DISCOVERY_UNAVAILABLE` everywhere without losing data. Removing the custom
domain takes it offline entirely. Clients treat `503` as `DISCOVERY_UNAVAILABLE`
and keep their own state.

To change who may publish, run `secret put DISCOVERY_PUBLISH_ALLOWLIST` again
with the full new list (it replaces the old value; do not rely on `rollback` to
restore a previous list). Opening publishing later is the same command with the
value `*`. To stop all publishing while keeping reads,
`npx wrangler@4.151.1 secret delete DISCOVERY_PUBLISH_ALLOWLIST` (publishes then
answer `503`).
