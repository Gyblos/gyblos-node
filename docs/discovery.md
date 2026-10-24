# Discovery index

`packages/discovery-http` (`@gyblos/discovery-http`) is an adapter for an HTTP
discovery index: a cache of node-signed public v2 records (catalog, presence)
that buyers query by model. **Nothing in the node or apps calls it yet**; the
seller publishing loop and buyer wiring are separate work.

The default base URL is `DISCOVERY_INDEX_URL` in `@gyblos/config`
(`https://discovery.gyblos.com/v1`). It is an operator value; there is no
environment variable for it yet. Anyone can run an index; the reference one is
`apps/discovery-index` ([discovery-index.md](discovery-index.md)), not deployed
yet.

## Trust model

The index is an **untrusted cache**. It never vouches for identity, never sees
prompts, offers or payments, and a buyer must assume it can lie, omit sellers,
replay old records or return garbage. The client therefore:

- re-verifies every entry locally with protocol `verifyPublicV2`: the catalog's
  Ed25519 signature by its NodeId and the v2 domain, both lifetimes at the
  caller's `now`, and the presence against that exact catalog (owner, NodeId,
  sequence, lifetime and `catalogDigest`);
- drops and counts (`dropped`) entries that fail, list another model, are at or
  below the caller's `lastSequence`, or lose to a higher-sequence entry for the
  same NodeId, rather than failing the whole page;
- bounds the response (read incrementally, about 1 MiB) before `JSON.parse`,
  validates the page shape strictly, applies a deadline to the whole request and
  refuses redirects;
- accepts only `https` base URLs (plain `http` only on loopback, for tests).

A verified record proves only that the NodeId key signed it. The `owner` field
is self-declared: buyers must still check the owner↔NodeId binding (see
[identity.md](identity.md)) and assign the checkability badge before
`selectSellers`.

## API

- `fetchSellers({ baseUrl, model, fetch, now, timeoutMs?, limit?, cursor?, lastSequence? })`
  returns `{ sellers, dropped, next, generatedAt }`. Each seller is
  `{ catalog, presence, withdrawal: null }` (`DiscoveredSeller`); the caller
  adds `badge` and `openChannel` to form a `KnownSeller`. `limit` (default 50,
  at most 200) is always sent. A NodeId repeated within a page keeps the entry
  with the highest catalog sequence. `next` is the opaque cursor for the
  following page.
- `publishRecord({ baseUrl, record, fetch, timeoutMs? })` posts one signed
  record (request body at most 34816 bytes) and resolves `{ ok: true }` on
  `201`.

Both take an injected `fetch` and never use the global one. Failures throw
`DiscoveryError` with a static code from `DISCOVERY_ERROR_CODES` and, when an
HTTP response was received, its `status`; messages never echo input or response
text. Index rejections map one-to-one (`INVALID_RECORD`, `INVALID_SIGNATURE`,
`EXPIRED_RECORD`, `UNKNOWN_CATALOG`, `STALE_RECORD`/`409`), as do `413`, `429`
and `503`; anything else is `DISCOVERY_HTTP_STATUS`. A deadline is always
`DISCOVERY_TIMEOUT`, including one that ends while reading a rejection body.

## Buyer duties: replay and withdrawal

`fetchSellers` verifies each page on its own; it keeps no state. A hostile index
can replay an older record pair that has not expired yet, or hide a withdrawal
and keep serving the withdrawn catalog with an earlier presence. The protocol
(`packages/protocol/SPEC.md`, "Trust, references, replay and withdrawal")
therefore makes the consumer responsible for replay state, and the buyer must
merge index results against its own per-NodeId state **before** `selectSellers`:

- Persist one high-water sequence per NodeId, shared by catalog, presence and
  withdrawal, and keep withdrawal tombstones at least through the maximum
  catalog lifetime. Do not reset it on restart.
- Pass `lastSequence: (nodeId) => highWater.get(nodeId)`. Entries whose presence
  sequence (an entry's highest, since it must exceed its catalog's) is at or
  below the known value are dropped and counted. `sellers` is then only what is
  newer than the buyer's state: an index re-serving the presence the buyer
  already holds yields nothing new for that NodeId, so the buyer keeps its held
  copy until it expires. Raise the high-water mark atomically when accepting an
  entry.
- Never let an index result revive a catalog the buyer holds a withdrawal for;
  only a higher-sequence catalog reopens it. The index never serves withdrawals,
  so `withdrawal` is always `null` here.
- A cold buyer with no state cannot detect a replay. The exposure is bounded by
  the presence lifetime (90 s), because every entry needs a live presence.

Cap the number of pages a caller follows: `next` comes from the index and a
malicious one can return a cursor forever.

## Seller duties

The seller publishing loop is not implemented yet. When it is:

- Time checks have zero clock-skew tolerance on both sides. `EXPIRED_RECORD` for
  a record just signed means the seller clock is wrong: sync it rather than
  retrying.
- Publishing a catalog replaces the stored one and clears its presence on the
  reference index, so publish a presence referencing the new catalog right
  after; until then the seller is not listed.
- Every record kind advances the same per-NodeId sequence, so sequences must
  increase across catalog, presence and withdrawal together.

## Running an index (wire contract)

Anyone can run an index (GYB-DOC-022). This section is the wire contract the
client and the reference index (`apps/discovery-index`) both follow. It lives
here rather than in `packages/protocol/SPEC.md` because SPEC.md fixes signed
record formats, domains and signing bytes, which the index stores and serves
unchanged; the HTTP service around those records is an adapter contract that can
change without touching signatures or golden vectors.

An index is an **untrusted cache** of node-signed public v2 records. It checks
records to keep junk out, but its acceptance proves only that the NodeId key
signed them: it never vouches for owner identity, registration or availability,
and clients must re-verify everything. It does not need, and should not store or
log, IP addresses, prompts, offers or payments.

The reference index base URL is `https://discovery.gyblos.com/v1`: the Worker
serves `POST /v1/records`, `GET /v1/sellers` and `GET /v1/health` at the root of
its own host. This client refuses redirects, so configure the exact base URL.
All paths below are relative to the base URL. Error bodies are
`{"error":"<CODE>"}` with a static code; an index never echoes request input.

### `POST /records`

- Request: `Content-Type: application/json` (optionally `; charset=utf-8`), body
  exactly `{"record":<signed envelope>}` with no other fields, where the
  envelope is `{"record":<public v2 record>,"signature":"<hex>"}`. At most 34816
  bytes (a canonical record may be 32 KiB, plus the envelope).
- Checks: strict shape (unknown fields rejected), canonical encoding and size,
  the Ed25519 signature by `record.nodeId` under the v2 domain for its kind, and
  lifetimes against the index clock with zero skew
  (`issuedAt <= now < expiresAt`, within 600 s for catalog and withdrawal, 90 s
  for presence).
- Sequence: one high-water mark per NodeId, shared across all three kinds. A
  record whose `sequence` is at or below it is stale. The mark is retained past
  record expiry (at least `expiresAt` plus the 600 s catalog lifetime) so stale
  replays stay rejected.
- References: a presence or withdrawal must reference the NodeId's current
  stored catalog exactly as `referenceV2` in `packages/protocol` does (same
  owner and NodeId, catalog sequence lower, catalog `issuedAt` no later, catalog
  `expiresAt` no earlier, catalog still live, matching `catalogDigest`), and
  that catalog must not be withdrawn.
- Effects: a catalog replaces the NodeId's catalog and clears its presence; a
  presence replaces the previous presence; a withdrawal tombstones the
  referenced catalog and clears its presence. Only a later, higher-sequence
  catalog reopens a withdrawn NodeId; a presence never revives it.

| Status | Body                    | Meaning                                                             |
| ------ | ----------------------- | ------------------------------------------------------------------- |
| `201`  | `{"ok":true}`           | Stored.                                                             |
| `400`  | `INVALID_RECORD`        | Wrong content type, shape, encoding or size of the record.          |
| `400`  | `INVALID_SIGNATURE`     | Signature does not verify.                                          |
| `400`  | `EXPIRED_RECORD`        | Not yet valid, expired, or lifetime too long.                       |
| `400`  | `UNKNOWN_CATALOG`       | Reference does not match a live, non-withdrawn stored catalog.      |
| `409`  | `STALE_RECORD`          | Sequence at or below the NodeId's high-water mark.                  |
| `413`  | `PAYLOAD_TOO_LARGE`     | Body over 34816 bytes.                                              |
| `429`  | `RATE_LIMITED`          | Per-IP, per-NodeId or capacity limit; `Retry-After` in seconds.     |
| `503`  | `DISCOVERY_UNAVAILABLE` | Storage or limits not configured, or storage failure (fail closed). |

There is no session or CAPTCHA: publishers authenticate by signature, and abuse
is bounded by rate limits, the size cap and one stored record per kind per
NodeId.

### `GET /sellers?model=<modelId>&limit=<n>&cursor=<c>`

- `model` is required: a model identifier (at most 128 characters, the protocol
  identifier charset). `limit` defaults to 50; the maximum is 200 and larger
  values are clamped. `cursor` is the `next` value of a previous page. Missing
  or malformed `model`, malformed `limit` or `cursor`, unknown parameters, or a
  repeated parameter give `400 {"error":"INVALID_QUERY"}`.
- `200` body:
  `{"sellers":[{"catalog":<envelope>,"presence":<envelope>}...], "next":<cursor or null>,"generatedAt":<index time in ms>}`.
  Envelopes are returned byte-for-byte as published.
- Inclusion: the NodeId's current catalog lists `model`, is live and not
  withdrawn, and its current presence is live and references that catalog. Order
  is deterministic (reference index: presence `issuedAt` descending, then
  NodeId); ranking is the buyer's job.
- Cursors are opaque: clients pass `next` back verbatim and must not parse or
  build them. This client accepts 1 to 512 characters of `[A-Za-z0-9._~-]`.
  `next` is `null` on the last page.
- The response is at most 1 MiB; an index stops adding entries before that size
  and returns `next`, so a page can hold fewer than `limit` entries.
- Headers: `Content-Type: application/json; charset=UTF-8`,
  `Cache-Control: public, max-age=10`, `Access-Control-Allow-Origin: *`.
- Errors: `400 INVALID_QUERY`, `429 RATE_LIMITED`, `503 DISCOVERY_UNAVAILABLE`.

### `GET /health`

`200 {"ok":true,"records":<count of stored unexpired records>}`, or
`503 {"error":"DISCOVERY_UNAVAILABLE"}`. Unknown paths answer
`404 {"error":"NOT_FOUND"}`. Responses other than `/sellers` carry
`Cache-Control: no-store`; all carry `X-Robots-Tag: noindex`. `GET` and `HEAD`
on `/sellers` and `/health` carry `Access-Control-Allow-Origin: *` on every
status, errors included. Limits, storage and operations of the reference index
are in [discovery-index.md](discovery-index.md).
