# Metrics collector Worker

`apps/metrics-collector` (`@gyblos/metrics-collector`) is the metrics collector:
a Cloudflare Worker at `https://collector.gyblos.com`, built with Hono and D1.

- **What it receives.** Release builds of the seller node, the buyer CLI and the
  desktop app upload their signed receipts and content-free telemetry
  observations, each in a signed
  [upload envelope](../packages/protocol/SPEC.md#receipt-upload-envelope-v1).
- **What stays private.** Raw receipts, observations and envelopes are never
  served.
- **What is public.** A scheduled run turns raw rows into
  [aggregates](#aggregates), and the [public stats API](#public-stats-api)
  serves aggregates only. A scheduled [chain index](#chain-index) reads the
  payment-channel program, the only source of settled amounts.

Every verification goes through `@gyblos/protocol`
(`verifyReceiptUploadEnvelope`) and `@gyblos/core/public-receipts`
(`classifyPublicReceipt`); the app keeps no copy of the signing or receipt
rules. The local receipt receiver for private testing is a different app
(`apps/receipt-collector`); see [receipts.md](receipts.md).

## Endpoints

| Route                           | Purpose                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `POST /v1/receipts`             | Upload one signed envelope of 1 to 50 receipts.                        |
| `POST /v1/observations`         | Upload one signed envelope of 1 to 200 content-free telemetry events.  |
| `GET /v1/health`                | `{ "ok": true }` once storage and every limiter exist.                 |
| `GET /v1/stats/network`         | Network totals per UTC day ([public stats](#public-stats-api)).        |
| `GET /v1/stats/models`          | Totals per model over a day range.                                     |
| `GET /v1/stats/sellers/:nodeId` | One seller's totals per day and per model.                             |
| `GET /v1/stats/chain`           | Payment-channels program activity per UTC day ([chain](#chain-stats)). |
| `GET /v1/admin/rpc-probe`       | Operator check of the chain RPC endpoints ([probe](#chain-index)).     |

Every response carries `Cache-Control: no-store`, except a successful stats
answer, which is `public, max-age=300`. Every response also carries
`X-Robots-Tag: noindex` and `X-Content-Type-Options: nosniff`. There is no CORS:
nodes upload, and the explorer (`apps/explorer`) reads the stats API from its
server. The collector is HTTPS only: a non-`https` URL gets `400 HTTPS_REQUIRED`
for every method and path, before storage or any limiter. Anything else is
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
[receipts.md](receipts.md)).

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

### `POST /v1/observations`

The same headers, body cap, admission, clock window, replay protection and
errors as `POST /v1/receipts`. The body is a signed
[observation upload envelope](../packages/protocol/src/observation-upload.ts):
the same uploader fields, with `events` in place of `items`, under its own
signing domain `gyblos/observation-upload/v1\n`. Re-sent events are stored once,
keyed by uploader and the exact record, and each event's `at` must fall within
the 30 days before `sentAt`.

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

## Uploader (nodes)

`@gyblos/node/receipt-uploader` sends a role's pending receipts and buffered
observations. The seller daemon and the shared buyer (CLI and desktop app) start
it next to their receipt runtime. The receipt store never evicts a receipt
before it is uploaded.

**When it uploads:**

- Every release build uploads to `https://collector.gyblos.com/v1`. That covers
  CLI builds with `GYBLOS_VERSION` and the packaged desktop app, which passes
  its version to the buyer it runs.
- Receipts have no opt-out.
- Observations are on by default. Set `GYBLOS_OBSERVATIONS=off` to stop sending
  them; the packaged desktop app passes this setting to its buyer.
- A build without a version uploads only when `GYBLOS_COLLECTOR_URL` is set, so
  tests and development never use the network.
- `GYBLOS_COLLECTOR_URL` must be `https`, or `http` on a loopback host, with no
  credentials, query or fragment. Any other value turns uploading off.

**What leaves the machine:**

- Each signed receipt: both NodeIds, the seller's owner wallet, the model and
  its settings, the engine kind, token counts, sizes, timings, outcome and price
  fields.
- Each observation: the validated telemetry record described in
  [telemetry.md](telemetry.md#events) (request id, NodeIds, model, timings,
  token counts, outcome and route; never content).
- Envelope metadata: the uploader's role, client kind (`seller-node`,
  `buyer-cli`, `buyer-desktop`), release version, platform and architecture, and
  the uploader's own store time.
- The collector also sees the uploader's IP address on the connection. It uses
  the address for rate limits and never stores it.
- Prompts, responses, keys and endpoint addresses are never sent.

**Receipts:**

- Batches of up to 50 receipts, every minute, and at once again after a full
  batch.
- Only a `200` carrying the collector's `receivedAt` and `accepted` equal to the
  batch size marks receipts uploaded. The acknowledgement uses the node's own
  clock. Redirects are refused.
- A network error, `5xx`, `429`, `413`, a non-stale `409`, or an unconfirmed
  `200` backs off from one minute, doubling up to one hour. The receipts stay
  pending.
- `STALE_UPLOAD` corrects the clock from `serverTime` and resends once.
- A batch refused as invalid is retried one receipt at a time. Receipts refused
  on their own are skipped for the life of the process, up to 200. If every
  receipt is refused, the envelope itself is the problem: the uploader backs off
  and marks nothing.
- The buyer's accepted offer facts are not sent (`offer` is `null`); the buyer's
  request start time arrives through observations.

**Observations:**

- Seller and buyer telemetry events go through an in-memory buffer of at most
  5,000 events. The buffer exists only when this process uploads, and doesn't
  depend on the local telemetry file setting.
- The uploader sends up to 200 events after each receipt batch. A failed send
  puts them back. A batch the collector refuses as invalid is dropped and
  counted, so it can't block later ones. A restart loses at most the buffered
  events.
- Observations are self-reported: a buyer can attach a refusal or failure to any
  seller, and node keys are free. Aggregates keep observations apart from
  receipt-backed figures and never count them against a seller without a
  confirming source.

**Effect on inference:** the uploader never blocks or retries inference.
`close()` aborts an upload in flight; anything not acknowledged stays pending.

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
own `at` (except in the per-model observations, where it falls on its receipt's
day). Never on the collector's arrival time. Late data marks its day dirty again
and the day is recomputed with a new `aggregated_at`. Ingest bounds
(`receivedAt` within the 30 days before the upload, see
[Order of checks](#order-of-checks)) keep every day real and recent, so only the
last 30 days can still change; a raw time past year 9999 is skipped by the scan
rather than stopping it.

**One day, one transaction.** Each table is a `DELETE` of the day plus one
`INSERT … SELECT … GROUP BY` over that day's raw rows. The day leaves the dirty
set in the same batch, so readers see the old day or the new one, never a mix. A
day whose batch fails stays dirty for the next run and never blocks the others.
The receipt part of a run is two reads, one scan batch of 5 statements (9 once
after a formula change) and 23 statements per day, whatever the day's row count
(the chain part follows with its own reads and batches); no statement binds more
than a few values. Sums use SQLite `total()`, which cannot overflow: they are
exact while a day's total stays below 2^53 (about 9 billion USDC in atomic
units) and approximate above. A run whose days fail logs
`COLLECTOR_AGGREGATION_FAILED` with the day names only. Every aggregate row
stores `formula_version` (`AGGREGATES.formulaVersion`) and `aggregated_at`.

| Table                                | One row per                             | Notes                                                         |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------- |
| `collector_agg_seller_daily`         | Seller × model × day × free/paid        | Variant and quantization are `''` when none.                  |
| `collector_agg_seller_hourly`        | Seller × model × UTC hour × free/paid   | Same columns; hour is epoch ms / 3600000.                     |
| `collector_agg_seller_buyers_daily`  | Seller × day × free/paid                | Unique buyers; public only at 5 or more.                      |
| `collector_agg_network_daily`        | Day × free/paid                         | Adds conflicts, active sellers, buyers and models served.     |
| `collector_agg_observed_daily`       | Day                                     | Buyer-experienced latency and the seller's network route.     |
| `collector_agg_demand_daily`         | Day × requested model                   | Unserved demand from buyer observations.                      |
| `collector_agg_model_observed_daily` | Model × day × free/paid                 | Buyer first token and engine speed, joined to receipts.       |
| `collector_first_seen`               | Seller, free buyer, paid buyer or model | Earliest headline receipt; basis for new users and retention. |

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
  seller signed it. It is not revenue: settled USDC comes only from the
  [chain index](#chain-index).
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
only chain settlement proves payment.

**Breakdowns** (migration `0005_breakdowns.sql`):

- `collector_agg_origin_daily`: headline requests per day, paid flag and the
  application of the buyer that reported them (`buyer-desktop`, `buyer-cli`), by
  outcome, with distinct buyers. The origin is the client of a buyer-role upload
  that carried the receipt; `unknown` when only the seller reported it (a buyer
  with uploads off, or one that never uploaded).
- `collector_agg_failures_daily`: failed, refused and unserved observations per
  day, by the side and application that reported them, event and reason, with
  events and distinct buyers. The reason is a failure's stop reason (for example
  `engine_timeout`), else its code (for example `FREE_EXECUTION_LIMIT_EXCEEDED`,
  the context limit, or `FREE_EXECUTION_CANCELLED`); a refusal's kind; `none`
  for unserved demand. Every value is a validated protocol enum.

Read them with care:

- A buyer and its seller each report a failure or refusal of the same request,
  so `buyer` and `seller` rows are two views of the same requests: never add
  them up.
- A receipt carried by uploads from both applications of one buyer key counts
  once, under the first client name in sort order (`buyer-cli`).
- Seller-side `buyers` counts the buyer NodeIds the seller itself reported: a
  claim, unlike buyer-side rows, where each buyer is a signing key.

`AGGREGATES.formulaVersion` 2 added them, so every day is recomputed once.

**Per-model observations** (migration `0007_model_observed.sql`):

- `collector_agg_model_observed_daily`: per model, day and paid flag, the
  buyer's first token and the engine's speed. Telemetry events do not say
  whether a request was free or paid, so each event is joined to its headline
  receipt (same request, seller and buyer); the receipt gives the paid flag, the
  model and the day (the seller's `receivedAt`). An event without such a receipt
  is not counted, so only a receipt's own buyer and seller add to it. Each
  receipt adds at most one sample of each kind (the lowest, if an event was
  uploaded more than once), so `samples` counts requests. A receipt day is
  recomputed when an observation of it arrives later.
- **Buyer first token:** buyer-role `first_token` events of streaming requests
  (a non-streaming completion also reports one, at its total time, and is left
  out). The buyer's clock starts at the attempt with the chosen seller: it
  includes the buyer's local payment and tokenizer startup, payment-session
  setup and channel opening, and the delivery of the first text, but not
  discovery or quotes. It therefore differs from the seller's first token in the
  receipt. Same latency buckets as above.
- **Engine speed:** seller-role `completed` events that carry the engine's own
  `generationMs` and output tokens: metered output tokens per second of
  generation, so prompt processing, network and queue time are left out. Only
  engines that report a generation time count (today Ollama's decode time).
  Buckets with upper bounds 1, 2, 5, 10, 20, 50, 100, 200, 500 and 1000 tokens
  per second, plus one bucket above. Higher is better, so the published median
  is the **lower** bound of its bucket: never more than was measured.
- Both are opt-in telemetry: samples come only from nodes that upload
  observations. With few samples a figure can describe very few buyers; it is
  not withheld.

`AGGREGATES.formulaVersion` 3 added them, so every day is recomputed once.

The aggregates do not include a signed daily snapshot (Merkle root and inclusion
proofs) or online sellers from presence, which the
[discovery index](discovery-index.md#uptime) reports. Chain figures are in
[Chain aggregates](#chain-aggregates).

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

A breakdown row (`origins`, `failures`) with fewer than 5 distinct buyers is
withheld whole: its labels stay, and `buyers`, `requests`, `outcomes` and
`events` are `null`. Withholding hides the row, not necessarily its value: the
day's `free` and `paid` totals and `demand` are always published, so a single
withheld row can follow from them by subtraction (for example free requests
minus the visible origins).

Unique buyer counts (`buyers`) come with `withheld`: below 5 (zero included) the
count is `null` and `withheld` is `true`, per seller and for the network. Only
the count is withheld: a seller's day and model totals (requests, tokens,
authorized amounts) are published whatever its number of buyers, so on a day
with one buyer they describe that one pseudonymous buyer's use of that seller.

| Route                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/stats/network`         | `days`: every day of the range with `free` and `paid` (plus `conflicts`, `activeSellers`, `modelsServed`, `buyers`, `withheld`); `observed` (`buyerLatency.firstToken`, `buyerLatency.total`, `routes.direct`, `routes.relay`, `routes.unknown`), `null` without observations that day; and `demand`: up to 20 models per day, largest first, each `modelId`, `unserved`, `refusedBeforeSelection`, `connectFailed`; `origins`: each `client`, `paid`, `requests`, `outcomes` (`completed`, `failed`, `cancelled`), `buyers`, `withheld`; and `failures`: each `side`, `client`, `event`, `reason`, `events`, `buyers`, `withheld`, most events first. |
| `GET /v1/stats/models`          | `models`: up to 100 models (model, variant and quantization) with the most completed requests, free and paid together, each with `free` and `paid` (plus `sellers`, and `observed`: `buyerFirstToken` as a latency, and `engineSpeed` with `samples`, `p50MinTokensPerSecond` (the lower bound of the median's bucket; `null` only without samples), `bucketsTokensPerSecond` and `counts`; `observed` is `null` without any observation joined to a receipt of that side, and either metric is empty, with `samples` 0, when only the other has data).                                                                                                |
| `GET /v1/stats/sellers/:nodeId` | `days`: every day of the range with `free` and `paid` plus `buyers` and `withheld`; `models`: up to 100 of the seller's models over the range, ordered as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Each stats request is one batch of reads over aggregate tables: five statements
for the network answer, three for the seller answer, two in one batch for
models, two for chain, whatever the range. Histograms are summed and lists are
capped in SQL.

### Chain stats

`GET /v1/stats/chain` takes the same range and envelope, plus `network` (the
CAIP-2 devnet id), `programId`, `mint` (devnet USDC) and `index`: whether the
program's history is fully read (`backfillDone`) and when the index last moved
(`updatedAt`), or `null` before its first run. Until `backfillDone`, older days
may still be missing. `days` lists every day of the range with `program` and
`gyblosClaimed`, each `null` without activity that day:

- `program` (anyone's traffic, from the signature list only): `transactions`
  (successful and failed) and `failed`;
- `gyblosClaimed` (read in full): `transactions`, `channels`, `payers`,
  `payees`, `undecodable`; `instructions`: `open`, `settle`, `topUp`,
  `settleAndSeal`, `requestClose`, `seal`, `distribute`, `reclaim`; and `usdc`:
  `depositedAtomic`, `settledAtomic`, `gyblosFeesAtomic`,
  `programTreasuryAtomic`, `refundedAtomic`, `paidOutAtomic`, as decimal
  strings.

This is the only source of settled USDC and fees: a paid receipt's
`authorizedAtomic` is usage both sides signed for, not payment. `gyblosClaimed`
is a self-declared label ([chain index](#chain-index)); wallets are public on
chain, so payer and payee counts are not withheld.

## Chain index

The scheduled run aggregates first, then reads the Solana payment-channel
program (`CHANNEL_PROGRAM` in `@gyblos/config`; code in `src/chain/`), so a slow
RPC never delays the stats. The chain is the only source of settled USDC and
fees: nothing here comes from node reports. Without a database the read is
skipped.

**What it costs.** The program is shared and busy (hundreds of other projects'
transactions a day, bursts of tens of thousands), so the index reads in full
only what concerns Gyblos and spends as few RPC calls as possible:

- It runs on the free public devnet RPC (`DEVNET_RPC_URL`), one call at a time
  (no JSON-RPC batches, which are billed and limited per call anyway), at least
  500 ms apart, at most 80 calls per run.
- Keyed RPCs are optional secrets, tried in order only when the endpoint before
  fails the run: `COLLECTOR_SOLANA_RPC_URL` (for example Helius, free tier),
  then `COLLECTOR_SOLANA_RPC_FALLBACK_URL` (for example Alchemy). Each is https
  (or http on loopback) with no credentials or fragment; a query may carry the
  provider key, since the URL is never logged. Each gets at most 20 calls per
  run. The run moves on after a refusal (HTTP 403 or 429, or the RPC's limit
  code), a server error (5xx) or a transport failure; an answer the index cannot
  read, or a transaction the RPC lists but cannot return yet, stops the run
  instead.
- The index reads devnet only. A key set to a known provider's mainnet host is
  read on that provider's devnet host with the same path and key
  (`CHAIN_DEVNET_HOSTS`: Helius and Alchemy). Before an endpoint's first call
  each run asks its genesis hash (`getGenesisHash`); an endpoint of another
  network (`DEVNET_GENESIS` differs) is refused as a wrong network, never
  counted as a rate limit, and the run moves to the next endpoint, so another
  network's signatures are never stored. A failed check (a timeout, an HTTP
  error) is asked again on the next call.
- The public devnet RPC answers Cloudflare Workers with HTTP 403 (measured
  2026-11-18), so in production each run spends one public call and moves to the
  first key.
- Every run logs `COLLECTOR_CHAIN_INDEX_RUN` with the calls, refusals and
  wrong-network refusals of the public endpoint and of the keys together
  (`publicWrongNetwork`, `paidWrongNetwork`), whether it moved on and to which
  endpoint (`endpoint=0` public, `1` the first key, `2` the second), what it
  counted, read and followed, the accounts read, and whether work is left
  (`backlog`).
- Measured once on devnet from one machine (not from Cloudflare): reading
  history cost 10 to 18 calls per run with no rate limit; once caught up, an
  idle run costs 1 call, plus one per followed channel and one per hundred
  Gyblos accounts every 30 minutes.

**RPC probe.** `GET /v1/admin/rpc-probe` lets the operator check every endpoint
the index may use before relying on it. The route exists only while the
`COLLECTOR_ADMIN_TOKEN` secret is set to at least 32 characters; without it, or
without `Authorization: Bearer <token>` matching it (compared in constant time),
or for any other method, it answers `404` like an unknown path. It calls the
public devnet RPC and each configured key in turn, once each, for one page of
the program's signature list (an optional `before=<signature>` pages back), with
the same genesis check as the index. Per endpoint it returns static facts only:
whether it is configured, whether it answered and in how many milliseconds, the
page's length, failed transactions, memos, Gyblos opens, signatures without a
block time, newest and oldest time and slot, and the last signature; on failure,
the static error, and whether it was a refusal or a wrong network. It never
returns a URL, a key or a provider's error text, and its answer is not cached
(`no-store`). It writes nothing.

**What is read, and when.** Finalized data, newest first, in five phases:

- **Gap, forward, history:** the program's signature list
  (`getSignaturesForAddress`, a thousand per call, each with its error, block
  time and memo): new signatures an earlier run could not cover (strictly
  between `gap_until` and `gap_before`), signatures newer than
  `newest_signature`, and history before `backfill_before`, up to 5 pages per
  phase and run, until `CHAIN_INDEX.historyFloorMs` (2026-11-01; earlier history
  is never read). Every listed signature is only counted per UTC day
  (`collector_chain_program_daily`: transactions and failed ones). A transaction
  is read in full (`getTransaction`, jsonParsed, versions 0 and 1) only when it
  succeeded and its memo opens a Gyblos channel.
- **Follow:** each Gyblos channel opened that way is followed through its own
  signature list, polled at most every 30 minutes, up to 40 channels per run:
  half for channels never polled, half for the least recently polled, so a burst
  of new opens (anyone can open one with a Gyblos memo) never starves the
  channels already known. Its later successful transactions are read in full,
  oldest first, at most 20 per poll (the rest wait for the next poll). A channel
  stops being followed once its account is gone (reclaimed), or when one poll
  returns a full page (a thousand transactions in 30 minutes only come from an
  attack): its later transactions are then no longer read, but its account state
  still is.
- **Accounts:** the accounts of the channels touched, of any never read, and of
  every Gyblos channel not closed whose state is older than 30 minutes
  (`getMultipleAccounts`, a hundred per call).

Each stored stretch is written in one transaction with the cursor that covers it
(`collector_chain_cursor`, a channel's `follow_until`), so every signature is
counted once and a failed run resumes where it stopped. The cursor also keeps
the slots of `newest_signature` and `gap_until`: a page holding older signatures
(a lagging node that ignored `until`) is refused rather than counted twice. A
lease (`lease_until`, 15 minutes) makes a run that overlaps another skip
(`skipped=true` in its log line). A failed list phase does not stop the follow
and account phases; the first failure is logged after them. After a full page, a
gap answered empty is closed only when the signature right before `gap_before`
is `gap_until` (one more call); otherwise it is a lagging RPC, retried next run.
A transaction the RPC lists but cannot return (`null`), an empty page for a
range known to hold signatures, a spent call budget or any RPC error stops the
run there. A failure logs `COLLECTOR_CHAIN_INDEX_FAILED` with the phase (`gap`,
`forward`, `backfill`, `follow`, `accounts`, or `start`), the error class, a
static reason (an HTTP status, an RPC error code, a shape location) and the
calls per endpoint, never a URL, which may carry a provider key. A secret that
is set but rejected logs `COLLECTOR_CHAIN_INDEX_FAILED config`.

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

| Table                           | One row per                | Notes                                                                                                   |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `collector_chain_txs`           | Transaction read in full   | Slot, block time (ms), failed, undecodable, first memo (untrusted text).                                |
| `collector_chain_instructions`  | Program instruction        | Kind, channel, parties, amount, voucher cumulative, splits.                                             |
| `collector_chain_token_deltas`  | Transaction × owner × mint | Net token change; the basis of settled USDC, fees and refunds.                                          |
| `collector_chain_channels`      | Channel                    | Parties and terms from open; deposit, settled, payout, status from its account; whether it is followed. |
| `collector_chain_cursor`        | Run state                  | Newest signature known, the open gap, where history stopped, done.                                      |
| `collector_chain_program_daily` | UTC day                    | The whole program's listed transactions and failed ones (none read).                                    |

**Channel state.** After storing, the run reads the account of every channel a
successful instruction named (and any never read): status (open, sealed,
closing, distributed), deposit, settled cumulative amount and payout watermark.
A missing account was reclaimed (`closed`); an account the program does not own,
or of another size, holds no channel (`unknown`). Both keep the last known
amounts.

**Gyblos traffic is a claim.** The program is shared. A channel is marked
`gyblos` when its open memo is Gyblos terms (`gyblos:`) or a Gyblos payment
session (`gyblos/payment-session/v1:`); only those channels are read in full. A
channel opened without that memo is never read, even if a distribute later pays
the Gyblos treasury (only a transaction read for a Gyblos channel can still mark
another channel it names). Anyone can make either claim, with any mint: metrics
built on it must filter by the USDC mint and say the label is self-declared.

### Chain aggregates

The same scheduled run recomputes chain days (`src/aggregate-chain.ts`,
migration `0004_chain_aggregates.sql`, table `collector_agg_chain_daily`) after
the receipt days, with their own scan cursor (`collector_agg_chain_state`),
dirty set (`collector_agg_chain_dirty_days`) and batch per day. The chain step
never throws: a failed chain scan (logged
`COLLECTOR_AGGREGATION_FAILED chain scan`) or chain day (`chain <days>`) is
retried next run and never holds back receipt or observation days or the chain
index that runs after. A day is the UTC day of the block time. The chain scan
marks dirty:

- the days of transactions indexed since the previous scan (`indexed_at`);
- every day of a channel that a newly indexed open or distribute names, so an
  open read after its settles (history is read newest first) or a later Gyblos
  claim recomputes the channel's earlier days;
- the days of a channel's settles at or after a newly indexed settle, since an
  older settle changes what later ones added, and every settle day of a channel
  after a newly indexed top-up, since deposits cap what settles count. Every
  mark is driven from the newly indexed transactions through indexes, so its
  cost follows what is new, and a new settle never re-marks the channel's whole
  history.

Before the first chain scan every indexed day is marked, and a formula change
re-marks every chain day aggregated with another version. Each dirty day gets
one row per scope: `program` (the whole program: only `transactions` and
`failed`, from its signature list counts; every other column is zero) and
`gyblos` (channels claiming Gyblos traffic, read in full); a scope with no
activity that day has no row.

- **Counts** (`gyblos`): successful transactions with an instruction in scope;
  top-level instructions by kind; distinct channels, payers and payees;
  `undecodable`: read transactions with a program instruction the decoder could
  not read (such a transaction is also in `transactions` when another of its
  instructions was read).
- **Amounts** count channels in the devnet USDC mint only, as decimal strings.
  `deposited`: open deposits plus top-ups. `settled`: each settle's signed
  cumulative, capped at the channel's deposits, above the highest one the
  channel settled before it, in chain order (a channel address derives from its
  open slot, so it is never reopened): alternating vouchers never add twice, and
  a self-signed cumulative never settles money the channel never held.
- **Payouts** are the positive USDC changes in distribute and reclaim
  transactions, by who received them: `gyblosFees` (the Gyblos fee treasury),
  `programTreasury` (the program's own treasury: rounding residual and
  redirected payouts), `refunded` (the payer of a channel the transaction names)
  and `paidOut` (a payee or distribute recipient). Owners the channels do not
  name never count, and a transaction whose payouts exceed what left its
  channels' vaults (a transfer bundled with the payout) counts none, so payouts
  never exceed what the program released. Within that bound a payer can still
  move its own refund to a payee it controls. Payouts are per transaction, so in
  the `gyblos` scope a transaction counts only when every distribute and reclaim
  in it is for a Gyblos channel.
- **Bounds:** sums use SQLite `total()`, so no value, however large, makes a day
  fail; they are exact below 2^53 atomic units (about 9 billion USDC) and
  saturate above. Instructions run through another program (CPI) are not read,
  so they are not counted.

The explorer doesn't read these aggregates, there is no mainnet treasury, and
nothing reconciles paid receipts against settled amounts: no node signs paid
receipt v2.

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

D1 tables are declared once with Drizzle and created by the migrations; a test
keeps both identical:

| Schema file                    | Migration                     | Tables                                                    |
| ------------------------------ | ----------------------------- | --------------------------------------------------------- |
| `src/schema.ts`                | `0001_metrics_collector.sql`  | Raw envelopes, reports, receipts, conflicts, observations |
| `src/schema-aggregates.ts`     | `0002_metrics_aggregates.sql` | `collector_agg_*`, `collector_first_seen`                 |
| `src/schema-chain.ts`          | `0003_chain_index.sql`        | `collector_chain_*`                                       |
| `src/schema-model-observed.ts` | `0007_model_observed.sql`     | `collector_agg_model_observed_daily`                      |

Raw rows are append-only. Envelopes are never pruned: a conflict's signed
receipt is kept only in its envelope's `signed_json`. Nothing stores an IP, a
request header, a prompt, a response or an endpoint address.

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

Nothing runs once per receipt beyond chunking. Multi-row statements stay under
D1's limit of 100 bound parameters per statement. A test pins the cost: 6
statements for one receipt and at most 30 for 50. The batch is one transaction:
a replayed nonce aborts it and nothing is written.

The shared write budget is the only ceiling on growth from free node keys, and
Cloudflare counts it per location, so it is approximate.

## Code layout

| Layer       | Files                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry       | `src/worker.ts`: bindings, the scheduled run and the stats edge cache; inert on import.                                                                                         |
| HTTP        | `src/app.ts`, `src/ip-key.ts`, `src/http.ts`, `src/stats-routes.ts`                                                                                                             |
| Use cases   | `src/ingest.ts`, `src/ingest-observations.ts`, `src/stats.ts`, `src/stats-chain.ts`                                                                                             |
| Policy      | `@gyblos/core/public-receipts`: receipt verification, classification and merge rules.                                                                                           |
| Storage     | `src/storage.ts` (port), `src/storage-d1*.ts` and `src/storage-memory.ts` (adapters)                                                                                            |
| Aggregation | `src/aggregate*.ts`, `src/sql-primitives.ts`                                                                                                                                    |
| Stats reads | `src/stats-store.ts` (port), `src/stats-read.ts` (D1)                                                                                                                           |
| Chain index | `src/chain/`: the scheduled read (`indexer.ts`, `list.ts`, `follow.ts`), call budgets and fallback (`endpoints.ts`), the RPC client, decoding and writes; `src/schema-chain.ts` |
| Values      | `src/constants.ts`, `src/errors.ts`                                                                                                                                             |

## Operations

Deploying, applying remote migrations, setting secrets and rebuilding aggregates
for this service is a maintainer procedure kept outside the repository. The
resource names, bindings and Cron Trigger are in
`apps/metrics-collector/wrangler.jsonc`. To check the deployed collector:

```sh
curl -s https://collector.gyblos.com/v1/health
```

The output is similar to the following:

```text
{"ok":true}
```
