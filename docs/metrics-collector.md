# Metrics collector Worker

`apps/metrics-collector` (`@gyblos/metrics-collector`) is the public receipt
collector: a Cloudflare Worker at `https://collector.gyblos.com`, built with
Hono and D1. Release builds of sellers, the buyer CLI and the buyer desktop app
send their signed receipts to it, plus their own timestamps, in the
[receipt upload envelope](../packages/protocol/SPEC.md#receipt-upload-envelope-v1),
and content-free observations. Raw rows stay private. A scheduled run turns them
into [aggregates](#aggregates), and the [public stats API](#public-stats-api)
serves aggregates only.

It was first deployed on 2026-11-16 with its own D1 database `gyblos-collector`.
Applying migrations and deploying are founder-approved manual steps (see
[Operations](#operations)). Every verification goes through `@gyblos/protocol`
(`verifyReceiptUploadEnvelope`) and `@gyblos/core/public-receipts`
(`classifyPublicReceipt`); the app keeps no copy of the signing or receipt
rules.

## Endpoints

| Route                           | Purpose                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `POST /v1/receipts`             | Upload one signed envelope of 1 to 50 receipts.                       |
| `POST /v1/observations`         | Upload one signed envelope of 1 to 200 content-free telemetry events. |
| `GET /v1/health`                | `{ "ok": true }` once storage and every limiter exist.                |
| `GET /v1/stats/network`         | Network totals per UTC day ([public stats](#public-stats-api)).       |
| `GET /v1/stats/models`          | Totals per model over a day range.                                    |
| `GET /v1/stats/sellers/:nodeId` | One seller's totals per day and per model.                            |

Every response carries `Cache-Control: no-store`, except a successful stats
answer, which is `public, max-age=300`. Every response also carries
`X-Robots-Tag: noindex` and `X-Content-Type-Options: nosniff`. There is no CORS:
only nodes call it. The collector is HTTPS only: a non-`https` URL gets
`400 HTTPS_REQUIRED` for every method and path, before storage or any limiter.
Anything else is `404 NOT_FOUND`.

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

| Status | Code                       | When                                                                                                                                                        |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `HTTPS_REQUIRED`           | The URL is not `https`.                                                                                                                                     |
| 400    | `INVALID_UPLOAD`           | Not JSON content, invalid UTF-8 or JSON, nesting deeper than 32, a malformed envelope, or an implausible receipt (see [Order of checks](#order-of-checks)). |
| 400    | `UNSUPPORTED_VERSION`      | An unknown envelope or receipt version.                                                                                                                     |
| 400    | `INVALID_SIGNATURE`        | The envelope signature or a receipt's node signature does not verify.                                                                                       |
| 400    | `UPLOAD_POLICY`            | The uploader is not party to a receipt, or an offer is below the signed amount.                                                                             |
| 400    | `INCONSISTENT_DISPUTE`     | A buyer's disputed fields contradict its own observations.                                                                                                  |
| 404    | `NOT_FOUND`                | Unknown route.                                                                                                                                              |
| 409    | `STALE_UPLOAD`             | `sentAt` is more than 10 minutes from the collector's clock. The body adds `serverTime`.                                                                    |
| 409    | `REPLAYED_UPLOAD`          | This uploader already used this nonce. Nothing is stored.                                                                                                   |
| 413    | `PAYLOAD_TOO_LARGE`        | The body is over 393216 bytes. It is refused before being buffered.                                                                                         |
| 429    | `RATE_LIMITED`             | An address, uploader or shared write limit was reached. Carries `Retry-After: 60`.                                                                          |
| 500    | `COLLECTOR_INTERNAL_ERROR` | An unexpected failure. Nothing about the request is logged or returned.                                                                                     |
| 503    | `COLLECTOR_UNAVAILABLE`    | Storage or a rate limiter is missing (fail closed).                                                                                                         |

**Clock correction.** On `STALE_UPLOAD` the client sets its offset to
`serverTime - its own now`. It then signs a new envelope with a fresh nonce and
the corrected `sentAt`. A node with a wrong clock still gets its data in, and
the skew is stored.

## Uploader (nodes)

`@gyblos/node/receipt-uploader` sends a role's pending receipts from its private
store, which never evicts a receipt before it is uploaded. The seller daemon and
the shared buyer (CLI and desktop) start it next to their receipt runtime.

**When it uploads:**

- Every release build uploads to `https://collector.gyblos.com/v1`, with no user
  setting to turn it off (founder decision 2026-11-16). This covers CLI builds
  with `GYBLOS_VERSION` and the packaged desktop app, which passes its version
  to the buyer it runs.
- A build without a version uploads only when `GYBLOS_COLLECTOR_URL` is set, so
  tests and development never use the network.
- `GYBLOS_COLLECTOR_URL` must be `https`, or `http` on a loopback host, with no
  credentials, query or fragment. Any other value turns uploading off.

**What leaves the machine:**

- Each signed receipt: both NodeIds, the seller's owner wallet, the model and
  its settings, the engine kind, token counts, sizes, timings, outcome and price
  fields.
- Envelope metadata: the uploader's role, client kind (`seller-node`,
  `buyer-cli`, `buyer-desktop`), release version, platform and architecture, and
  the uploader's own store time.
- The collector also sees the uploader's IP address on the connection. It uses
  the address for rate limits and never stores it.
- Prompts, responses, keys and endpoint addresses are never sent.

**Behavior:**

- **Pacing:** batches of up to 50 receipts, every minute, and immediately again
  after a full batch.
- **What counts as uploaded:** only a `200` carrying the collector's
  `receivedAt` and `accepted` equal to the batch size marks receipts uploaded,
  and the acknowledgement uses the node's own clock. Redirects are refused.
- **Failures:**
  - A network error, `5xx`, `429`, `413`, a non-stale `409`, or an unconfirmed
    `200` backs off from one minute, doubling up to one hour. The receipts stay
    pending.
  - `STALE_UPLOAD` corrects the clock from `serverTime` and resends once.
  - A batch refused as invalid is retried one receipt at a time. Receipts
    refused on their own are skipped for the life of the process, up to 200. If
    every receipt is refused, the envelope itself is the problem: the uploader
    backs off and marks nothing.
- **Effect on inference:** it never blocks or retries inference.
- **Stopping:** `close()` aborts an upload in flight. Anything not yet
  acknowledged stays pending.
- **Observations are on by default and can be turned off** with
  `GYBLOS_OBSERVATIONS=off` (founder decision 2026-11-16). Receipts have no
  opt-out. The packaged desktop passes this setting to its buyer.
- **Observations are self-reported.** A buyer can attach a refusal or failure to
  any seller, and node keys are free. Totals must keep observations apart from
  receipt-backed figures, and must never count them against a seller without a
  confirming source. Re-sent events are stored once, keyed by uploader and the
  exact record, and each event's `at` must fall within 30 days before `sentAt`.
- **Observations:** the seller and buyer telemetry events go through an
  in-memory buffer of at most 5000 events. The buffer exists only when this
  process uploads, and does not depend on the local telemetry file opt-in. The
  uploader sends up to 200 events after each receipt batch. A failed send puts
  them back. A batch the collector refuses as invalid is dropped and counted, so
  it cannot block later ones. A restart loses at most the buffered events.
- **Not sent yet:**
  - the buyer's accepted offer facts (`offer` is still `null`);
  - paid v2 receipts, until nodes emit them.

  The buyer's request start time arrives through observations.

  The HTTP client lives in `@gyblos/node`. Moving it into an adapter package,
  and the collector's route and error codes into the protocol, is follow-up
  work.

### `POST /v1/observations`

The same headers, body cap, admission, clock window, replay protection and
errors as `POST /v1/receipts`. The body is a signed
[observation upload envelope](../packages/protocol/src/observation-upload.ts):
the same uploader fields, with `events` in place of `items`, under its own
signing domain `gyblos/observation-upload/v1\n`.

Each event must be exactly core's validated telemetry projection
(`toTelemetryRecord`). The kinds are request received, first token, completed,
failed, charged, refused and unserved. Each is checked as follows:

- **Undeclared fields:** an event with any undeclared field (for example a
  prompt) is refused with `INVALID_UPLOAD`. It is never silently dropped,
  because the signed envelope is stored verbatim.
- **Ownership:** each event must be the uploader's own, in its role: a buyer's
  `buyerNodeId`, or a seller's `sellerNodeId`. Otherwise it is `UPLOAD_POLICY`.
- **Receipts:** receipt events are refused with `UPLOAD_POLICY`; receipts go to
  `/v1/receipts`.

Success is `{ "receivedAt": …, "accepted": n }`. One upload is one envelope
insert plus chunked observation inserts in one transaction (1 + ⌈200/10⌉
statements at most).

These events carry what receipts cannot:

- unserved demand and refusals before a seller is chosen;
- connection failures;
- the latency the buyer experienced;
- the seller's route;
- the time each request started (`at` on the request's events, joined by
  `requestId`).

## Aggregates

A Cron Trigger runs every 10 minutes (`*/10 * * * *`, `scheduled` in
`src/worker.ts`) and calls `runAggregation` (`src/aggregate.ts`). Migration
`0002_metrics_aggregates.sql` holds the tables.

**Which days.** One scan batch marks a UTC day dirty when a receipt changed
(`updated_at`), an observation arrived (`inserted_at`) or a conflict was stored
since the previous scan, minus a 15-minute overlap so an upload committed during
a scan is never missed. After a deploy with a new `AGGREGATES.formulaVersion`,
the scan also marks, once, every day aggregated with another version, so a
formula change recomputes history by itself. The cursor, with the last applied
formula version, is `collector_agg_state`. A run recomputes at most 31 dirty
days, newest first, so old days marked dirty can never starve today; the rest
wait for the next run.

**Source time.** Every item falls on the day of its own source time: a receipt
on the day of the seller's signed `receivedAt`, an observation on the day of its
own `at`. Never on the collector's arrival time. Late data marks its day dirty
again and the day is recomputed with a new `aggregated_at`. Ingest bounds
(`receivedAt` within the 30 days before the upload, see
[Order of checks](#order-of-checks)) keep every day real and recent, so only the
last 30 days can still change; a raw time past year 9999 is skipped by the scan
rather than stopping it.

**One day, one transaction.** Each table is a `DELETE` of the day plus one
`INSERT … SELECT … GROUP BY` over that day's raw rows. The day leaves the dirty
set in the same batch, so readers see the old day or the new one, never a mix. A
day whose batch fails stays dirty for the next run and never blocks the others.
A run is two reads, one scan batch of 4 statements (6 once after a formula
change) and 17 statements per day, whatever the day's row count; no statement
binds more than a few values. Sums use SQLite `total()`, which cannot overflow:
they are exact while a day's total stays below 2^53 (about 9 billion USDC in
atomic units) and approximate above. A run whose days fail logs
`COLLECTOR_AGGREGATION_FAILED` with the day names only. Every aggregate row
stores `formula_version` (`AGGREGATES.formulaVersion`) and `aggregated_at`.

| Table                               | One row per                             | Notes                                                         |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `collector_agg_seller_daily`        | Seller × model × day × free/paid        | Variant and quantization are `''` when none.                  |
| `collector_agg_seller_hourly`       | Seller × model × UTC hour × free/paid   | Same columns; hour is epoch ms / 3600000.                     |
| `collector_agg_seller_buyers_daily` | Seller × day × free/paid                | Unique buyers; public only at 5 or more.                      |
| `collector_agg_network_daily`       | Day × free/paid                         | Adds conflicts, active sellers, buyers and models served.     |
| `collector_agg_observed_daily`      | Day                                     | Buyer-experienced latency and the seller's network route.     |
| `collector_agg_demand_daily`        | Day × requested model                   | Unserved demand from buyer observations.                      |
| `collector_first_seen`              | Seller, free buyer, paid buyer or model | Earliest headline receipt; basis for new users and retention. |

**Formulas (version 1).**

- **Requests:** the headline is `bilateral + seller-only`. `disputed` is counted
  apart and adds nothing else; conflicts (evidence against one side) are only
  counted, never added to any total.
- **Outcomes and success rate:** completed, failed and cancelled over headline
  receipts; success rate = completed / (completed + failed + cancelled). Every
  receipt already reached a seller; refusals and unserved demand are not here.
- **Tokens:** the seller-signed input, output and reasoning counts of headline
  receipts. A receipt without a reasoning count adds to `reasoning_unknown`,
  never to zero.
- **Authorized usage:** the sum of `amountAtomic` and `feeAtomic` of paid
  receipts **both sides signed** (bilateral), in USDC atomic units. A
  seller-only paid receipt counts as a request but adds no amount: only the
  seller signed it. It is not revenue: settled USDC comes only from the chain
  (#349, not built yet).
- **Buyers:** free buyers are distinct NodeIds; paid buyers are distinct wallets
  (`payer`, or the NodeId when a paid receipt names none). Free and paid are
  separate rows and are never added up.
- **Active sellers and models served:** distinct sellers and distinct
  `model/variant/quantization` with at least one completed headline receipt.
- **Latency:** fixed-bucket histograms (upper bounds 100, 200, 500, 1000, 2000,
  5000, 10000, 20000, 30000 and 60000 ms, plus one bucket above; a value equal
  to a bound falls in the next bucket), so hours, days, sellers and models can
  be summed; percentiles are never averaged. Seller first-token latency covers
  headline receipts; seller total latency covers completed ones.
  Buyer-experienced latency comes from the buyer's own `first_token` and
  `completed` observations and is kept apart.
- **Network route:** the seller's `completed` and `failed` observations by
  `path.route`: direct, relay, or unknown (no path or `unknown`).
- **Unserved demand:** from buyer observations, per requested model, in three
  disjoint counts: `unserved`, refused before a seller was chosen (except
  connect failures), and connect failures. A refusal by a chosen seller is not
  demand that no seller served.
- **First seen:** the earliest headline receipt time per seller, free buyer,
  paid buyer and model. Recomputing an earlier day can only move it earlier.

**What the numbers can and cannot prove.** Node keys are free. A seller-only
receipt needs only the seller's signature, and a "bilateral" one can come from
two keys of the same person, so request, token, buyer, seller and model counts
can be inflated with self-made keys (sybils). Observations are self-reported by
their uploader and never count against a seller without a confirming source.
Read every figure as what nodes reported and signed, not as proof of real use;
only chain settlement (#349) proves payment.

Not yet included: the daily signed snapshot with a Merkle root and inclusion
proofs, chain metrics (transactions, settled USDC, fees; they need the indexer
in #349), and online sellers from presence (they live in the discovery index).

## Public stats API

`GET` only, aggregates only: never a receipt, a buyer identity or a raw
observation. Query parameters `from` and `to` are UTC days (`YYYY-MM-DD`); the
range is inclusive and at most 92 days long (for example 2026-08-17 to
2026-11-16). The default is the 30 days up to today. A malformed, impossible,
reversed or too long range, or a NodeId that is not 64 lowercase hex characters,
answers `400 INVALID_QUERY`. Without a database the stats routes answer
`503 COLLECTOR_UNAVAILABLE`. Reads spend their own per-address budget
(`COLLECTOR_READ_LIMITER`, 120 per minute). A successful answer is
`Cache-Control: public, max-age=300` and the Worker keeps it in the edge cache,
keyed by URL, so repeated reads cost no database query; errors are never cached.

Every answer has `from`, `to`, `formulaVersion` (the version every row in the
answer was computed with, or `null` when there is no data or a recompute after a
formula change is under way) and `aggregatedAt` (when the newest row in the
answer was computed, or `null` without data). Totals come in a `free` and a
`paid` section, each `null` when there is no data; they are never summed. Each
section has:

- `requests`: `headline`, `bilateral`, `sellerOnly`, `disputed`;
- `outcomes`: `completed`, `failed`, `cancelled`, and `successRate` (`null`
  without outcomes);
- `tokens`: `input`, `output`, `reasoning`, `reasoningUnknown`;
- `sellerLatency.firstToken` and `sellerLatency.total`: `samples`, `p50Ms`,
  `p95Ms` (the upper bound of the bucket holding the percentile; `null` when
  empty or above 60000 ms), `bucketsMs` and `counts`;
- free only: `backedByPayment: false`;
- paid only: `authorizedAtomic` and `feeAtomic` (bilateral receipts only), as
  decimal strings.

Unique buyer counts (`buyers`) come with `withheld`: below 5 (zero included) the
count is `null` and `withheld` is `true`, per seller and for the network. Only
the count is withheld: a seller's day and model totals (requests, tokens,
authorized amounts) are published whatever its number of buyers, so on a day
with one buyer they describe that one pseudonymous buyer's use of that seller.

| Route                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/stats/network`         | `days`: every day of the range with `free` and `paid` (plus `conflicts`, `activeSellers`, `modelsServed`, `buyers`, `withheld`); `observed` (`buyerLatency.firstToken`, `buyerLatency.total`, `routes.direct`, `routes.relay`, `routes.unknown`), `null` without observations that day; and `demand`: up to 20 models per day, largest first, each `modelId`, `unserved`, `refusedBeforeSelection`, `connectFailed`. |
| `GET /v1/stats/models`          | `models`: up to 100 models (model, variant and quantization) with the most completed requests, free and paid together, each with `free` and `paid` (plus `sellers`).                                                                                                                                                                                                                                                 |
| `GET /v1/stats/sellers/:nodeId` | `days`: every day of the range with `free` and `paid` plus `buyers` and `withheld`; `models`: up to 100 of the seller's models over the range, ordered as above.                                                                                                                                                                                                                                                     |

Each stats request is one batch of reads over aggregate tables: three statements
for the network and seller answers, one for models, whatever the range.
Histograms are summed and lists are capped in SQL.

## Chain index

The scheduled run aggregates first, then reads the Solana payment-channels
program (`CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`, `src/chain/`), so a
slow RPC never delays the stats. The chain is the only source of settled USDC
and fees: nothing here comes from node reports. Without a database or a valid
`COLLECTOR_SOLANA_RPC_URL` secret (https, or http on loopback, with no
credentials, query or fragment) the read is skipped.

**What is read, and when.** Finalized transactions of the program, through
`getSignaturesForAddress`, `getTransaction` (jsonParsed, transaction versions 0
and 1) in batched JSON-RPC requests (redirects refused, answers capped at 8 MiB
and matched by id), and `getMultipleAccounts`. A run reads at most 200
transactions and one page of signatures per phase, newest first within each:

1. **Gap:** new signatures an earlier run could not fit, strictly between
   `gap_until` and `gap_before`.
2. **Forward:** signatures newer than `newest_signature`. When they do not all
   fit, the newest are read and the rest becomes the gap.
3. **History:** signatures before `backfill_before`, until the program's first
   transaction. An empty program is not marked done.

Each batch of transactions is stored in one transaction together with the cursor
that covers it (`collector_chain_cursor`), so every signature is read exactly
once and a failed run resumes where it stopped. A transaction the RPC lists but
cannot return (`null`), a missing batch reply or any RPC error stops the run
before that batch. A failure logs `COLLECTOR_CHAIN_INDEX_FAILED` with the phase
(`gap`, `forward`, `backfill`, `accounts`) and the error class only, never the
URL, which may carry a provider key.

**How a transaction is read** (`src/chain/decode.ts`, @x402/svm 2.28): every
top-level program instruction by its one-byte discriminator — open (1), settle
(2), top_up (3), settle_and_seal (4), request_close (5), seal (6), distribute
(7), reclaim (9) — with its channel and parties from the account list, open's
salt, deposit, open slot and splits, top_up's amount, and distribute's splits. A
settle's cumulative amount is the voucher of the Ed25519 instruction right
before it, counted only when the voucher names the same channel (and, for
settle_and_seal, when it says it carries one). The net token change per owner
and mint is stored as it happened: what distribute actually paid (seller, Gyblos
fee, refund, or a payout the program redirected to its treasury), and what open
and top_up deposited. Amounts are exact decimal text.

Anyone can send transactions to the program. A **failed** transaction is stored
with no instructions or token changes. A program instruction of a successful
transaction this decoder cannot read is counted in `undecodable`, never guessed
and never fatal. Program calls made through another program (inner instructions)
are not read; their token changes are.

| Table                          | One row per                | Notes                                                                           |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------- |
| `collector_chain_txs`          | Finalized transaction      | Slot, block time (ms), failed, undecodable, first memo (untrusted text).        |
| `collector_chain_instructions` | Program instruction        | Kind, channel, parties, amount, voucher cumulative, splits.                     |
| `collector_chain_token_deltas` | Transaction × owner × mint | Net token change; the basis of settled USDC, fees and refunds.                  |
| `collector_chain_channels`     | Channel                    | Parties and terms from open; deposit, settled, payout, status from its account. |
| `collector_chain_cursor`       | Run state                  | Newest signature known, the open gap, where history stopped, done.              |

**Channel state.** After storing, the run reads the account of every channel a
successful instruction named (and any never read): status (open, sealed,
closing, distributed), deposit, settled cumulative amount and payout watermark.
A missing account was reclaimed (`closed`); an account the program does not own,
or of another size, holds no channel (`unknown`). Both keep the last known
amounts.

**Gyblos traffic is a claim.** The program is shared. A channel is marked
`gyblos` when its open memo is Gyblos terms (`gyblos:`) or a Gyblos payment
session (`gyblos/payment-session/v1:`), or when a distribute paid the Gyblos
treasury. Anyone can make either claim, with any mint: metrics built on it must
filter by the USDC mint and say the label is self-declared.

Not yet included: daily chain aggregates and their public API (transactions by
kind, settled USDC, fees), the explorer reading them, the mainnet treasury, and
the reconciliation of paid receipt v2 intervals against settled amounts — no
node signs v2 receipts yet (#346).

## Order of checks

The cheapest checks run first, and nothing expensive happens before the request
is signed:

1. HTTPS, storage and all four limiters present.
2. Per-address limit: IPv4 by address, IPv6 by `/64`. The address is never
   stored or logged. Public stats reads spend their own per-address budget
   (`COLLECTOR_READ_LIMITER`), so readers and uploads never block each other.
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
9. Each receipt plausible (`plausibleReceipt`): the seller's signed `receivedAt`
   at most 30 days before the envelope's `sentAt` and at most one hour after it
   (the seller's and the uploader's clocks may differ); `amountAtomic` and
   `feeAtomic` at most 10^12; every token count at most 10^8. One implausible
   receipt refuses the envelope with `INVALID_UPLOAD`; the uploader then retries
   one receipt at a time and skips it. Old days cannot be rewritten, and a
   receipt kept on a node for more than 30 days is no longer counted.
10. The shared write budget, spent only by fully verified uploads.
11. One storage read and one transactional write.

## Storage

D1 tables are declared once in `src/schema.ts` (Drizzle) and created by
`migrations/0001_metrics_collector.sql`; a test keeps both identical. Raw rows
are append-only. Envelopes are never pruned: a conflict's signed receipt is kept
only in its envelope's `signed_json`. Nothing stores an IP, a request header, a
prompt, a response or an endpoint address.

| Table                      | One row per                      | Holds                                                                                                                                                                         |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collector_envelopes`      | Accepted envelope                | The canonical signed envelope and its signature (re-verifiable), uploader, role, client kind/version/platform/arch, `sent_at`, `received_at`, skew, unique (uploader, nonce). |
| `collector_reports`        | Item per reporting side          | The receipt key and digests, the uploader's `stored_at`, `started_at` and offer facts, and an advisory merge label.                                                           |
| `collector_receipts`       | Request (seller, buyer, request) | The first accepted version: digests, status, normalized seller fields for aggregation, the receipt, and the first report time per side.                                       |
| `collector_conflicts`      | Conflicting report               | Seller or buyer conflict. The signed receipt is in its envelope.                                                                                                              |
| `collector_observations`   | Telemetry event                  | Type, the uploader's `at`, request id, seller, model, and the validated record (other fields read with `json_extract`).                                                       |
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

| Layer            | File                                                                                                                                 | Owns                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Entry            | `src/worker.ts`                                                                                                                      | Cloudflare bindings, the scheduled run and the stats edge cache; fails closed; inert on import. |
| HTTP             | `src/app.ts`, `src/ip-key.ts`                                                                                                        | Routes, admission middleware, body cap, error mapping.                                          |
| Use case         | `src/ingest.ts`                                                                                                                      | The order of checks and building one write.                                                     |
| Policy           | `@gyblos/core/public-receipts`                                                                                                       | Receipt verification, classification and merge rules.                                           |
| Storage port     | `src/storage.ts`                                                                                                                     | The `CollectorStorage` interface and the shared write rule.                                     |
| Storage adapters | `src/storage-d1.ts`, `src/storage-memory.ts`                                                                                         | D1 (Drizzle, `src/schema.ts`, `src/d1-client.ts`) and in-memory.                                |
| Values           | `src/constants.ts`, `src/errors.ts`                                                                                                  | Wire codes, statuses, limits, binding names, error mapping.                                     |
| Aggregation      | `src/aggregate.ts`, `src/aggregate-sql.ts`, `src/aggregate-first-seen.ts`, `src/sql-primitives.ts`, `src/schema-aggregates.ts`       | The scheduled run, metric formulas, SQL building blocks and the aggregate tables.               |
| Chain index      | `src/chain/` (`indexer.ts`, `decode.ts`, `rpc.ts`, `writes.ts`, `channel-account.ts`, `base58.ts`, `json.ts`), `src/schema-chain.ts` | The scheduled chain read, transaction decoding, the RPC client and the chain tables.            |
| Stats use case   | `src/stats.ts`, `src/stats-shape.ts`, `src/days.ts`                                                                                  | Typed answers, free/paid sections, percentiles, UTC day ranges.                                 |
| Stats port       | `src/stats-store.ts`, `src/stats-read.ts`                                                                                            | The `StatsReader` interface and its D1 adapter.                                                 |
| Stats HTTP       | `src/stats-routes.ts`, `src/http.ts`                                                                                                 | Query parsing, cacheable answers, shared rejection.                                             |

## Operations

Every step needs founder approval. The database, the first three rate limits,
the route and migration `0001` were set up and deployed on 2026-11-16.

To ship a change, from `apps/metrics-collector`:

1. Apply new migrations:
   `npx wrangler@4.151.1 d1 migrations apply gyblos-collector --remote`.
2. Deploy: `npx wrangler@4.151.1 deploy`. This also registers the Cron Trigger
   and the read limiter (`namespace_id` 42621013, which must be unused in the
   account).
3. For the chain index, after migration `0003`, set the Solana RPC URL as a
   secret: a dedicated provider over https, since the public devnet RPC
   rate-limits `getTransaction` to a few calls per window:
   `npx wrangler@4.151.1 secret put COLLECTOR_SOLANA_RPC_URL`.

After `0002`, the first scheduled run marks every day with data dirty and
recomputes up to 31 days per run, newest first.

To rebuild every aggregate from raw (for example to verify a formula), delete
the rows of every `collector_agg_*` table and of `collector_first_seen`; the
next run marks every day with raw data dirty again.

One upload can run about 30 D1 statements in a batch. Watch the database size:
the shared write budget is the only ceiling on growth from free node keys, and
Cloudflare counts it per location, so it is approximate.
