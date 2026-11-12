# Discovery index

`packages/discovery-http` (`@gyblos/discovery-http`) is an adapter for an HTTP
discovery index: a cache of node-signed public v2 records (catalog, presence)
that buyers query by model. The buyer can opt into it through `selection.json`
while preserving independently configured identity/endpoint bindings. The seller
can explicitly opt into publication through the same verified record lifecycle
used by its Iroh control service.

The default base URL is `DISCOVERY_INDEX_URL` in `@gyblos/config`
(`https://discovery.gyblos.com/v1`). Buyers override it in `selection.json`;
sellers use `GYBLOS_DISCOVERY_URL` when publication is enabled. Anyone can run
an index; the reference implementation is `apps/discovery-index`
([configuration and operations](discovery-index.md)).

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

- `fetchSellers({ baseUrl, model, fetch, now, timeoutMs?, signal?, limit?, cursor?, lastSequence? })`
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
and `503`; a `403` on publish is `DISCOVERY_PUBLISH_NOT_ALLOWED` (the index does
not accept this NodeId as a publisher); anything else is
`DISCOVERY_HTTP_STATUS`. A deadline is always `DISCOVERY_TIMEOUT`, including one
that ends while reading a rejection body. An optional caller `signal` cancels
headers and body reads with `DISCOVERY_CANCELLED`, even when an injected fetch
ignores its signal.

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

## Buyer runtime integration

Add optional `"discovery": {}` to the existing buyer `selection.json` to use the
configured default index, or set `baseUrl` and `maxPages` inside that object.
The `sellers` list remains an independent NodeId/endpoint allowlist with
expected owners. Optional `identity` uses read-only 8004 verification and
durable binding floors; only explicit per-seller `manualTrust: true` overrides
it. Without identity configuration, existing owner–NodeId pairs retain manual
trust. See [identity admission](identity.md#durable-buyer-identity-admission);
unknown or mismatched index identities are discarded before storage or dialing.
There is no automatic enrollment or inferred 8004 identity proof. Badges remain
`declared-usage` and `openChannel` remains false.

The default traversal is three pages of at most 50 entries each, with a maximum
of eight pages and an absolute 10-second discovery deadline. Cursor cycles or a
non-final page at the configured cap fail with `BUYER_DISCOVERY_LIMIT`; no
quotes are requested. Index errors stop preauthorization rather than silently
switching to a different payment path. Equal signed entries and omitted entries
can retain an already held candidate ID while its verified presence remains
live.

`discovery-state-v2.json` under `homeLayout(...).roles.buyer` stores only owner,
NodeId, shared high-water sequence, catalog/presence digests and expiries, and
withdrawal/conflict sequence barriers. It caches no signed proof or offer: held
metadata is only a bounded dialing hint. Every candidate must return fresh
signed catalog/presence over authenticated Iroh; the buyer rechecks independent
identity, exact references and replay state, and persists the observation before
selection. The final quote also rechecks the latest durable catalog/withdrawal
barrier.

The HTTP adapter is asked to return equal sequences for digest comparison; the
buyer applies its persistent replay policy after verification. Replayed entries
never replace newer state. Equal-sequence conflicts block the NodeId; a catalog
must advance beyond the barrier/high-water mark to reopen it. Withdrawals
learned from configured signed records are verified against the exact catalog
and retained through expiry, restarts and config omissions. A newer presence
cannot revive a withdrawn catalog. The index does not serve withdrawals, so an
unknown hidden withdrawal remains a discovery limitation, bounded by signed
presence lifetime.

Replay metadata uses file mode 0600 and buyer-directory mode 0700, staged
replace, file synchronization and POSIX directory synchronization. Updates
serialize and reread disk state under a separate exclusive
`discovery-state-v2.lock`; an existing lock, malformed state, unsafe permissions
or failed persistence stops selection. The lock is never automatically broken
after a crash. Tombstones/high-water marks are not pruned on config changes; at
1,024 historical identities or 1 MiB state the buyer fails closed. Existing
metadata needs deliberate operator repair rather than automatic reset. Windows
power-loss durability is not established here.

Discovery runs only in the unsigned preauthorization step. The existing proxy
binds its decision to exact request ID/body; signed follow-ups never rediscover,
select again or retry. Non-trusted winners stop after their signed quote.
Execution still requires the independently trusted compatible v1 offer; no v2
payment or free-v2 execution is enabled. See
[running-a-node.md](running-a-node.md).

### Open discovery

With `"discovery": { "open": true }` (which requires `identity`), the buyer also
uses sellers it never configured: for each catalog the index lists for the
model, the catalog's owner must hold that NodeId in the 8004 registry, checked
before anything is remembered, exactly as for a configured seller. Such a seller
is dialed by NodeId through the first configured relay (`GYBLOS_RELAYS`); the
index supplies no address. Configured sellers come first and the candidate list
stays within 16. Their stats live in memory only, so `selection-stats.json`
keeps the configured sellers alone. With open discovery `sellers` may be empty.
The usual replay and withdrawal checks still apply.

## Seller duties

The seller publisher is opt-in. Set `GYBLOS_DISCOVERY_PUBLISH=1` when starting
`node:start`; `GYBLOS_DISCOVERY_URL` optionally overrides the configured index.
Without the opt-in, the node makes no discovery publication requests. The index
operator must separately authorize its NodeId when publication is allowlisted;
enabling the node publisher never changes that list. URL policy is the adapter's
policy: HTTPS, or HTTP on loopback only; credentials, query strings and
fragments are rejected.

The publisher sends a signed catalog before its presence. It checks every ten
seconds, rotates catalogs before expiry, and backs off failed publication by
10/20/40/60 seconds (capped at 60 seconds). An uncertain acknowledgement forces
a fresh, higher-sequence catalog on the next attempt, rather than replaying an
old write. Requests have an absolute five-second deadline covering headers and
body. Publication failures are reported as a static degraded health status
(including `DISCOVERY_PUBLISH_NOT_ALLOWED` for an unapproved NodeId); they do
not initiate inference, payment, or a different paid route.

Catalog renewal is bounded by the current model-readiness observation. The
publisher and control queries never probe, warm or load the engine. A separate
node lifecycle checks every ten seconds and starts a bounded private one-token
warmup when the observation has two minutes left, or after expiry/failure. It
checks memory headroom before and after, rejects new OOM events, and verifies
the startup model name, digest and context. A successful check anchors a new
four-minute observation to that warmup; it never extends the legacy paid offer.

Busy inference skips a check. Starting inference cancels a pending check; late
results cannot restore availability. A check has a ninety-second deadline and
retains its single work slot until underlying work actually settles, even if the
engine ignores cancellation. There is no overlapping or queued check backlog.
During checks, failure, expiry or shutdown, local catalogs, presence and quotes
fail closed immediately. The publisher retires on its next tick; remote expiry
still bounds an undelivered withdrawal. Recovery requires a higher catalog tied
to the new observation generation, even if failure/recovery occur between ticks.
After inference becomes idle, the lifecycle refreshes the catalog independently
of whether HTTP publication is enabled. These are cached availability
observations, not capacity reservations or a guarantee of subsequent admission.

Shutdown disables local catalog/quote snapshots first, cancels in-flight
publication and attempts one higher signed withdrawal while the reference
catalog is still valid. A failed/unreachable withdrawal is not a guarantee of
immediate remote removal: signed presence/catalog expiration remains the
fallback. A signature already started cannot escape after local retirement.
Cancelled control requests are checked before queued reservations and before
signing. The shared presence-work queue is capped at the control query capacity
(32); if a disk operation stalls, cancelled queued slots stay occupied until it
settles, so later requests are refused instead of accumulating unbounded work.
An already-started durable reservation cannot be interrupted; cancellation may
burn that sequence without starting a signature.

`ROLE_FILES.publicSequence` under the seller home stores the public-v2 sequence
high-water mark, bound to its NodeId. Catalogs, HTTP presence, Iroh presence and
withdrawals all reserve from this one allocator **before signing**. State uses
0600 files, a 0700 seller directory, an exclusive per-update lock, staged atomic
replacement, file sync and POSIX directory sync. Reservations may be skipped
when signing or delivery fails, but are never reused by the allocator. Existing
state is reread on each reservation; malformed/wrong-node state, unsafe paths,
lock contention, overflow, missing held state or observed rollback fail closed.

Preserve this file across restarts and backup restores. The initial floor uses
the startup clock for compatibility with earlier timestamp-based catalogs;
subsequent persisted values remain monotonic even if that clock moves backward.
A crash during an update may leave a lock: the node never automatically breaks
it. Operator inspection/repair is required without resetting the high-water
mark. Recovery: `pnpm gyblos doctor` reports `SEQUENCE_LOCK_PRESENT`; confirm no
seller is running with this `GYBLOS_HOME` (the daemon, or a lab harness using
it; for example `pgrep -fl 'gyblos|bin.ts start'`), then remove only
`public-sequence-v2.lock` and any `public-sequence-v2.json.*.tmp` left beside it
in the seller directory. Never edit or delete `public-sequence-v2.json`. Since
the first signal after startup starts a stop that ignores further Ctrl-C until
withdrawal and this write finish, a lock is expected only after a crash, a
forced kill (`kill -9`), power loss, or a Ctrl-C during startup (startup signs
its first catalog before the stop handler is installed). There is no hardware
anti-rollback anchor: deleting/restoring all local state across process restarts
is not supported recovery, and Windows power-loss durability is not established
here.

Control quotes remain v2-only observations, without reservations or execution.
The paid v1 offer and HTTP bridge routes are unchanged. Automatic identity
registration, public index deployment, off-host/load acceptance and v2 execution
remain separate work.

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

An index is HTTPS only. Any request that does not arrive over `https`, whatever
its method or path, gets `400 {"error":"HTTPS_REQUIRED"}` before any other
check; it is never redirected, so a request body is never resent in the clear.
(A reference index created for development also accepts plain `http` on a
loopback host.) This client maps that code on a publish to
`DISCOVERY_INSECURE_URL`; it already refuses non-loopback `http` base URLs
before sending anything.

### `POST /records`

- Request: `Content-Type: application/json` (optionally `; charset=utf-8`), body
  exactly `{"record":<signed envelope>}` with no other fields, where the
  envelope is `{"record":<public v2 record>,"signature":"<hex>"}`. At most 34816
  bytes (a canonical record may be 32 KiB, plus the envelope).
- Checks: strict shape (unknown fields rejected), canonical encoding and size,
  the Ed25519 signature by `record.nodeId` under the v2 domain for its kind, and
  lifetimes against the index clock, accepting a record issued up to 5 s ahead
  of it and no expiry grace (`issuedAt <= now + 5 s`, `now < expiresAt`, within
  600 s for catalog and withdrawal, 90 s for presence).
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

| Status | Body                    | Meaning                                                            |
| ------ | ----------------------- | ------------------------------------------------------------------ |
| `201`  | `{"ok":true}`           | Stored.                                                            |
| `400`  | `INVALID_RECORD`        | Wrong content type, shape, encoding or size of the record.         |
| `400`  | `INVALID_SIGNATURE`     | Signature does not verify.                                         |
| `400`  | `EXPIRED_RECORD`        | Not yet valid, expired, or lifetime too long.                      |
| `400`  | `UNKNOWN_CATALOG`       | Reference does not match a live, non-withdrawn stored catalog.     |
| `403`  | `PUBLISH_NOT_ALLOWED`   | The index accepts records only from listed NodeIds (an allowlist). |
| `409`  | `STALE_RECORD`          | Sequence at or below the NodeId's high-water mark.                 |
| `400`  | `HTTPS_REQUIRED`        | The request did not use `https` (any route).                       |
| `413`  | `PAYLOAD_TOO_LARGE`     | Body over 34816 bytes.                                             |
| `429`  | `RATE_LIMITED`          | Per-IP, per-NodeId or capacity limit; `Retry-After` in seconds.    |
| `503`  | `DISCOVERY_UNAVAILABLE` | Storage, limits or publishing not configured, or storage failure.  |

There is no session or CAPTCHA: publishers authenticate by signature, and abuse
is bounded by rate limits, the size cap and one stored record per kind per
NodeId. An index may also restrict publishing to listed NodeIds (the reference
index does during devnet); it may refuse an unlisted claimed `nodeId` with `403`
before verifying the signature. Reads stay public.

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
  `Cache-Control: public, max-age=10`, `Access-Control-Allow-Origin: *`. An
  index may serve a `200` page from a cache for up to those 10 seconds, so
  `generatedAt` can be that old; errors are never cached.
- Errors: `400 INVALID_QUERY`, `400 HTTPS_REQUIRED`, `429 RATE_LIMITED`,
  `503 DISCOVERY_UNAVAILABLE`.

### `GET /health`

`200 {"ok":true,"records":<count of stored unexpired records>}` (the reference
index adds `"publish"`, its publish mode; clients must not rely on it), or
`503 {"error":"DISCOVERY_UNAVAILABLE"}`. Unknown paths answer
`404 {"error":"NOT_FOUND"}`. Responses other than `/sellers` carry
`Cache-Control: no-store`; all carry `X-Robots-Tag: noindex`. `GET` and `HEAD`
on `/sellers` and `/health` carry `Access-Control-Allow-Origin: *` on every
status, errors included. Limits, storage and operations of the reference index
are in [discovery-index.md](discovery-index.md).
