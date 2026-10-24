# Discovery index

`packages/discovery-http` (`@gyblos/discovery-http`) is an adapter for an HTTP
discovery index: a cache of node-signed public v2 records (catalog, presence)
that buyers query by model. **Nothing in the node or apps calls it yet**; the
seller publishing loop and buyer wiring are separate work.

The default base URL is `DISCOVERY_INDEX_URL` in `@gyblos/config`
(`https://www.gyblos.com/api/v1/discovery`). It is an operator value; there is
no environment variable for it yet. Anyone can run an index.

## Trust model

The index is an **untrusted cache**. It never vouches for identity, never sees
prompts, offers or payments, and a buyer must assume it can lie, omit sellers,
replay old records or return garbage. The client therefore:

- re-verifies every entry locally with protocol `verifyPublicV2`: the catalog's
  Ed25519 signature by its NodeId and the v2 domain, both lifetimes at the
  caller's `now`, and the presence against that exact catalog (owner, NodeId,
  sequence, lifetime and `catalogDigest`);
- drops and counts (`dropped`) entries that fail, list another model or repeat a
  NodeId, rather than failing the whole page;
- bounds the response (read incrementally, about 1 MiB) before `JSON.parse`,
  validates the page shape strictly, applies a deadline to the whole request and
  refuses redirects;
- accepts only `https` base URLs (plain `http` only on loopback, for tests).

A verified record proves only that the NodeId key signed it. The `owner` field
is self-declared: buyers must still check the owner↔NodeId binding (see
[identity.md](identity.md)) and assign the checkability badge before
`selectSellers`.

## API

- `fetchSellers({ baseUrl, model, fetch, now, timeoutMs?, limit?, cursor? })`
  returns `{ sellers, dropped, next, generatedAt }`. Each seller is
  `{ catalog, presence, withdrawal: null }` (`DiscoveredSeller`); the caller
  adds `badge` and `openChannel` to form a `KnownSeller`. `next` is the opaque
  cursor for the following page.
- `publishRecord({ baseUrl, record, fetch, timeoutMs? })` posts one signed
  record (at most 16 KiB) and resolves `{ ok: true }` on `201`.

Both take an injected `fetch` and never use the global one. Failures throw
`DiscoveryError` with a static code from `DISCOVERY_ERROR_CODES` and, when an
HTTP response was received, its `status`; messages never echo input or response
text. Index rejections map one-to-one (`INVALID_RECORD`, `INVALID_SIGNATURE`,
`EXPIRED_RECORD`, `UNKNOWN_CATALOG`, `STALE_RECORD`/`409`), as do `413`, `429`
and `503`; anything else is `DISCOVERY_HTTP_STATUS`.
