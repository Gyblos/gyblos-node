# Discovery index Worker

`apps/discovery-index` (`@gyblos/discovery-index`) is the reference HTTP
discovery index: a Cloudflare Worker for `https://discovery.gyblos.com`, built
with Hono. It implements the wire contract in
[discovery.md](discovery.md#running-an-index-wire-contract), which the
`@gyblos/discovery-http` client follows. It moved here from the website so that
record verification has a single source: every record check goes through
`@gyblos/protocol` (`parsePublicV2`, `validatePublicV2Time`, `controlVerify` and
`verifyPublicV2`); the app keeps no copy of the record rules.

**It is not deployed.** Creating Cloudflare resources and deploying are
founder-approved manual steps (see [Operations](#operations)).

## Endpoints

Routes sit at the root of the index host; the client base URL is
`https://discovery.gyblos.com/v1` (`DISCOVERY_INDEX_URL` in `@gyblos/config`).

| Route              | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `POST /v1/records` | Publish one signed public v2 catalog, presence or withdrawal. |
| `GET /v1/sellers`  | List live sellers of one model, paged by an opaque cursor.    |
| `GET /v1/health`   | `{ ok: true, records, publish }` (see below).                 |

Anything else is a real `404 {"error":"NOT_FOUND"}`. Every response carries
`X-Robots-Tag: noindex`; responses other than `/v1/sellers` carry
`Cache-Control: no-store`. `GET`/`HEAD` on `/v1/sellers` and `/v1/health` carry
`Access-Control-Allow-Origin: *` on every status, errors included.

`records` in the health body is the count of unexpired records; `publish` is
`"closed"`, `"allowlist"` or `"open"` (the publish mode, never the listed
NodeIds). `publish` is a reference-index extension that clients must not rely
on.

## Publish allowlist (devnet)

Reads are public. During devnet only approved NodeIds may publish: the Worker
secret `DISCOVERY_PUBLISH_ALLOWLIST` holds them as comma-separated lowercase
64-hex NodeIds (whitespace around commas is ignored, duplicates collapse), at
most 1000 entries. The single value `*` opens publishing to any self-signed
NodeId, the permissionless design for later.

- **Fail closed:** if the secret is missing, empty, or has any malformed entry
  (uppercase, wrong length, an empty item such as a trailing comma, `*` mixed
  with NodeIds, more than 1000 entries), every `POST /v1/records` answers
  `503 DISCOVERY_UNAVAILABLE` before the body is read or any publish limit is
  consumed. `GET /v1/sellers` and `GET /v1/health` keep working.
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

## Security model and limits

The index is an untrusted cache. Acceptance proves only that the NodeId key
signed a record; clients re-verify everything.

- **Fail closed:** without the `DISCOVERY_DB` binding or any of the three
  rate-limit bindings, every route answers `503 DISCOVERY_UNAVAILABLE`, as does
  any storage failure. Without a valid publish allowlist, only publishing is
  `503`. Errors are static codes; input is never echoed, and nothing is logged.
- **Development relaxation:** `createDiscoveryIndex({ development: true })`
  replaces missing limiters with in-memory counters, only for requests to a
  loopback host, and never relaxes storage or the publish allowlist. The Worker
  entry (`src/worker.ts`) always passes `development: false`.
- **Rate limits:** `DISCOVERY_IP_LIMITER` on every request and
  `DISCOVERY_PUBLISH_LIMITER` on publishes, keyed by client address (IPv4 by
  full address, IPv6 by its /64 prefix); `DISCOVERY_NODE_LIMITER` keyed by the
  verified NodeId, consumed only by records that would advance its high-water
  mark. A limiter that refuses or fails is `429 RATE_LIMITED` with
  `Retry-After: 60`.
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
  `429`). Expired rows are pruned when a new NodeId publishes, at most once a
  minute per isolate, with index-only deletes.
- **Privacy:** no IP address, header, session or request metadata is stored or
  logged; rate-limit keys go only to Cloudflare limiters.

## Storage

`src/storage.ts` defines the storage contract and an in-memory adapter (tests
and local runs); `src/storage-d1.ts` is the D1 adapter, with minimal local D1
interfaces instead of `@cloudflare/workers-types`. A publish is one D1 batch
(one transaction) whose statements apply only if its high-water upsert won.

`migrations/0001_discovery_index.sql` creates the five tables and their indexes.
The website's draft `0001` and `0002` (prune indexes) were never applied to any
database, so they are combined into this one clean migration.

Tests run the same HTTP cases against the in-memory adapter and a `node:sqlite`
D1 double that applies the real migration (`tests/support/d1-sqlite.ts`); CI
needs no Cloudflare account.

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
# rate-limit namespace ids 42621004-42621006 must not collide with the website's
# web/wrangler.jsonc (it uses 42621001-42621003); then uncomment ratelimits and
# routes (custom domain discovery.gyblos.com, zone gyblos.com in this account)
# publish allowlist: paste comma-separated approved NodeIds at the prompt
# (or `*` to open publishing); without it the index serves reads but answers
# 503 to every publish
npx wrangler@4.151.1 secret put DISCOVERY_PUBLISH_ALLOWLIST
npx wrangler@4.151.1 deploy
curl -s https://discovery.gyblos.com/v1/health
# expected: 200 {"ok":true,"records":0,"publish":"allowlist"}
curl -si https://discovery.gyblos.com/nope | grep -i x-robots-tag
# expected: 404 with noindex
curl -si 'https://discovery.gyblos.com/v1/sellers?model=x' | grep -i access-control
# expected: Access-Control-Allow-Origin: *
```

Rollback: `npx wrangler@4.151.1 rollback` returns to the previous version; or
comment out `d1_databases` (or a rate limit) and deploy again; the index then
answers `503 DISCOVERY_UNAVAILABLE` everywhere without losing data. Removing the
custom domain takes it offline entirely. Clients treat `503` as
`DISCOVERY_UNAVAILABLE` and keep their own state.

To change who may publish, run `secret put DISCOVERY_PUBLISH_ALLOWLIST` again
with the full new list (it replaces the old value; do not rely on `rollback` to
restore a previous list). Opening publishing later is the same command with the
value `*`. To stop all publishing while keeping reads,
`npx wrangler@4.151.1 secret delete DISCOVERY_PUBLISH_ALLOWLIST` (publishes then
answer `503`).
