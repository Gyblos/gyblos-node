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
| `GET /v1/health`   | `{ ok: true, records }`, the count of unexpired records.      |

Anything else is a real `404 {"error":"NOT_FOUND"}`. Every response carries
`X-Robots-Tag: noindex`; responses other than `/v1/sellers` carry
`Cache-Control: no-store`. `GET`/`HEAD` on `/v1/sellers` and `/v1/health` carry
`Access-Control-Allow-Origin: *` on every status, errors included.

## Security model and limits

The index is an untrusted cache. Acceptance proves only that the NodeId key
signed a record; clients re-verify everything.

- **Fail closed:** without the `DISCOVERY_DB` binding or any of the three
  rate-limit bindings, every route answers `503 DISCOVERY_UNAVAILABLE`, as does
  any storage failure. Errors are static codes; input is never echoed, and
  nothing is logged.
- **Development relaxation:** `createDiscoveryIndex({ development: true })`
  replaces missing limiters with in-memory counters, only for requests to a
  loopback host, and never relaxes storage. The Worker entry (`src/worker.ts`)
  always passes `development: false`.
- **Rate limits:** `DISCOVERY_IP_LIMITER` on every request and
  `DISCOVERY_PUBLISH_LIMITER` on publishes, keyed by client address (IPv4 by
  full address, IPv6 by its /64 prefix); `DISCOVERY_NODE_LIMITER` keyed by the
  verified NodeId, consumed only by records that would advance its high-water
  mark. A limiter that refuses or fails is `429 RATE_LIMITED` with
  `Retry-After: 60`.
- **Publish order:** per-IP limit, the 34816-byte body cap (`413`), publish
  limit, content type, strict JSON, then shape, lifetime and the self-signature.
  Only then is the stored high-water mark checked: stale replays are `409`
  before the per-NodeId limit, so replaying a seller's records cannot exhaust
  its allowance, and unsigned junk never reaches that limit.
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
npx wrangler@4.151.1 d1 create gyblos-discovery
# put the printed database_id into wrangler.jsonc and uncomment d1_databases
npx wrangler@4.151.1 d1 migrations apply gyblos-discovery --remote
# check in the dashboard that rate-limit namespace ids 42621004-42621006 are
# unused in the account (the website uses 42621001-42621003), then uncomment
# ratelimits and routes (custom domain discovery.gyblos.com)
npx wrangler@4.151.1 deploy
curl -s https://discovery.gyblos.com/v1/health
# expected: 200 {"ok":true,"records":0}
```

Rollback: comment out `d1_databases` (or a rate limit) and deploy again; the
index then answers `503 DISCOVERY_UNAVAILABLE` everywhere without losing data.
Removing the custom domain takes it offline entirely. Clients treat `503` as
`DISCOVERY_UNAVAILABLE` and keep their own state.
