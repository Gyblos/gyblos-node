# Metrics collector Worker

`apps/metrics-collector` (`@gyblos/metrics-collector`) is the proposed public
receipt collector: a Cloudflare Worker for `https://collector.gyblos.com`
(proposed), built with Hono and D1. Sellers, the buyer CLI and the buyer desktop
app send their signed receipts to it, plus their own timestamps, in the
[receipt upload envelope](../packages/protocol/SPEC.md#receipt-upload-envelope-v1).
It keeps the rows private. It has no public reads or aggregates yet.

It is **not deployed**, and its D1 database `gyblos-collector` does not exist.
Creating Cloudflare resources, applying migrations and deploying are
founder-approved manual steps (see [Operations](#operations)). Every
verification goes through `@gyblos/protocol` (`verifyReceiptUploadEnvelope`) and
`@gyblos/core/public-receipts` (`classifyPublicReceipt`); the app keeps no copy
of the signing or receipt rules.

## Endpoints

| Route               | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `POST /v1/receipts` | Upload one signed envelope of 1 to 50 receipts.        |
| `GET /v1/health`    | `{ "ok": true }` once storage and every limiter exist. |

Every response carries `Cache-Control: no-store`, `X-Robots-Tag: noindex` and
`X-Content-Type-Options: nosniff`. There is no CORS: only nodes call it. The
collector is HTTPS only: a non-`https` URL gets `400 HTTPS_REQUIRED` for every
method and path, before storage or any limiter. Anything else is
`404 NOT_FOUND`.

### `POST /v1/receipts`

Request: `Content-Type: application/json` and a body of at most 393216 bytes.
The body is one signed envelope:

```json
{
  "upload": {
    "version": 1,
    "uploaderNodeId": "<64 hex>",
    "role": "seller",
    "client": {
      "kind": "seller-node",
      "appVersion": "0.1.0-beta.11",
      "platform": "linux",
      "arch": "x64"
    },
    "sentAt": 1800000000000,
    "nonce": "<32 hex>",
    "items": [
      {
        "receipt": { "seller": { "record": {}, "signature": "<128 hex>" } },
        "storedAt": 1799999999000,
        "startedAt": null,
        "offer": null
      }
    ]
  },
  "signature": "<128 hex>"
}
```

The full field rules are in the protocol SPEC. In short:

- The uploader is each receipt's seller (seller role) or buyer (buyer role).
- `startedAt` and `offer` are buyer-only, and `offer` is allowed only on paid
  receipts.

Success, `200`:

```json
{ "receivedAt": 1800000000123, "accepted": 1 }
```

The response says only how many receipts were accepted, so an uploader cannot
learn whether the other side has reported. Accepted does not mean counted:
conflicts are kept as evidence and excluded from totals (see
[receipt-policy.md](receipt-policy.md)).

Errors are `{ "error": "<CODE>" }` with a static code; input is never echoed.

| Status | Code                       | When                                                                                      |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------- |
| 400    | `HTTPS_REQUIRED`           | The URL is not `https`.                                                                   |
| 400    | `INVALID_UPLOAD`           | Not JSON content, invalid UTF-8 or JSON, nesting deeper than 32, or a malformed envelope. |
| 400    | `UNSUPPORTED_VERSION`      | An unknown envelope or receipt version.                                                   |
| 400    | `INVALID_SIGNATURE`        | The envelope signature or a receipt's node signature does not verify.                     |
| 400    | `UPLOAD_POLICY`            | The uploader is not party to a receipt, or an offer is below the signed amount.           |
| 400    | `INCONSISTENT_DISPUTE`     | A buyer's disputed fields contradict its own observations.                                |
| 404    | `NOT_FOUND`                | Unknown route.                                                                            |
| 409    | `STALE_UPLOAD`             | `sentAt` is more than 10 minutes from the collector's clock. The body adds `serverTime`.  |
| 409    | `REPLAYED_UPLOAD`          | This uploader already used this nonce. Nothing is stored.                                 |
| 413    | `PAYLOAD_TOO_LARGE`        | The body is over 393216 bytes. It is refused before being buffered.                       |
| 429    | `RATE_LIMITED`             | An address, uploader or shared write limit was reached. Carries `Retry-After: 60`.        |
| 500    | `COLLECTOR_INTERNAL_ERROR` | An unexpected failure. Nothing about the request is logged or returned.                   |
| 503    | `COLLECTOR_UNAVAILABLE`    | Storage or a rate limiter is missing (fail closed).                                       |

**Clock correction.** On `STALE_UPLOAD` the client sets its offset to
`serverTime - its own now`. It then signs a new envelope with a fresh nonce and
the corrected `sentAt`. A node with a wrong clock still gets its data in, and
the skew is stored.

## Order of checks

The cheapest checks run first, and nothing expensive happens before the request
is signed:

1. HTTPS, storage and all three limiters present.
2. Per-address limit: IPv4 by address, IPv6 by `/64`. The address is never
   stored or logged.
3. JSON content type, then a body cap enforced from `Content-Length` or while
   streaming, before buffering.
4. Strict UTF-8, JSON and depth checks; the envelope structure and party binding
   (`parseReceiptUpload`).
5. The envelope signature: one Ed25519 verification.
6. The clock window.
7. The per-uploader limit. It runs only after the signature, so unsigned junk
   cannot spend another node's allowance.
8. Each receipt verified once, by the public policy: up to 100 Ed25519
   verifications.
9. The shared write budget, spent only by fully verified uploads.
10. One storage read and one transactional write.

## Storage

D1 tables are declared once in `src/schema.ts` (Drizzle) and created by
`migrations/0001_metrics_collector.sql`; a test keeps both identical. Raw rows
are append-only. Nothing stores an IP, a request header, a prompt, a response or
an endpoint address.

| Table                      | One row per                      | Holds                                                                                                                                                                         |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collector_envelopes`      | Accepted envelope                | The canonical signed envelope and its signature (re-verifiable), uploader, role, client kind/version/platform/arch, `sent_at`, `received_at`, skew, unique (uploader, nonce). |
| `collector_reports`        | Item per reporting side          | The receipt key and digests, the uploader's `stored_at`, `started_at` and offer facts, and an advisory merge label.                                                           |
| `collector_receipts`       | Request (seller, buyer, request) | The first accepted version: digests, status, normalized seller fields for aggregation, the receipt, and the first report time per side.                                       |
| `collector_conflicts`      | Conflicting report               | Seller or buyer conflict. The signed receipt is in its envelope.                                                                                                              |
| `collector_status_history` | Status change                    | Insert as seller-only, bilateral or disputed, and a later upgrade.                                                                                                            |

**Query cost.** One upload costs one typed read for all its keys and one
transactional batch:

- The envelope insert.
- Report inserts, chunked.
- One set-based conflict insert, compared against the stored rows.
- Receipt upserts, chunked. They never replace a first seller record or a first
  buyer attestation.
- One set-based history insert.
- One set-based first-report-time update.

Nothing runs once per receipt beyond chunking. Multi-row statements are split
under D1's limit of 100 bound parameters per statement. A test pins the cost: 6
statements for one receipt, at most 30 for 50, and no statement over 100
parameters. The batch is one transaction: a replayed nonce aborts it and nothing
is written.

## Code layout

| Layer            | File                                         | Owns                                                             |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Entry            | `src/worker.ts`                              | Cloudflare bindings to the app; fails closed; inert on import.   |
| HTTP             | `src/app.ts`, `src/ip-key.ts`                | Routes, admission middleware, body cap, error mapping.           |
| Use case         | `src/ingest.ts`                              | The order of checks and building one write.                      |
| Policy           | `@gyblos/core/public-receipts`               | Receipt verification, classification and merge rules.            |
| Storage port     | `src/storage.ts`                             | The `CollectorStorage` interface and the shared write rule.      |
| Storage adapters | `src/storage-d1.ts`, `src/storage-memory.ts` | D1 (Drizzle, `src/schema.ts`, `src/d1-client.ts`) and in-memory. |
| Values           | `src/constants.ts`, `src/errors.ts`          | Wire codes, statuses, limits, binding names, error mapping.      |

## Operations

All of these steps need founder approval. None has been done.

1. Create the D1 database `gyblos-collector` and put its id in `wrangler.jsonc`.
2. Create the three rate-limit namespaces. The ids in `wrangler.jsonc` are
   unverified placeholders and must be unused in the account.
3. Apply `migrations/` to the remote database.
4. Route `collector.gyblos.com` and deploy with `npx wrangler@4.151.1 deploy`.

One upload can run about 30 D1 statements in a batch. Watch the database size:
the shared write budget is the only ceiling on growth from free node keys, and
Cloudflare counts it per location, so it is approximate.
