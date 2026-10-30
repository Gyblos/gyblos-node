# Private free-receipt collector policy

`@gyblos/core/receipt-collector` implements the first private ingestion policy,
without an HTTP endpoint, filesystem backend, exporter or startup wiring. It
accepts existing `receipt/v1` pairs, not inference requests, payments or public
statistics. No receipt leaves a process through this API.

## Boundary and ownership

`createPrivateReceiptCollector(store).collect(body, signal?)` takes one complete
canonical JSON UTF-8 byte body containing the existing `{ seller, buyer }`
envelope. This is an in-process policy boundary, not a newly registered network
protocol. No protocol fields, signing domains or golden vectors change.

The collector checks:

- Nonempty bytes, at most 4096 bytes and depth 16, strict UTF-8 and canonical
  JSON. Duplicate keys, trailing data and alternate whitespace are rejected.
- Strict existing receipt parsers, both node signatures, request/peer linkage
  and the buyer's binding to the seller receipt digest.
- Free pricing only; the existing parser requires amount and fee to be zero.
- A buyer attestation is mandatory. Its dispute fields must exactly match the
  discrepancies in its known input/output token counts and output bytes.

Disputes are retained as disputes. Unknown observations stay `null`; differences
in the two parties' latency observations are allowed. A signature attests a
claim, not truthful usage, delivery, a model or identity ownership. This layer
makes no RPC/index queries and does not verify owner-to-node registry bindings.
It applies no freshness/expiry policy: receipt timestamps are signed historical
claims, not expiring quotes. Fraud detection, aggregate accounting and public
ranking remain separate work.

## Atomic storage contract

`PrivateReceiptStore.insert(entry, signal?)` is injected, with no default
implementation. The entry contains the verified detached pair, its canonical
`[sellerNodeId, buyerNodeId, requestId]` key and a SHA-256 fingerprint of the
entire canonical pair, including signatures. The fingerprint is a storage
identity, not a new signing domain.

The backend must atomically return:

- `INSERTED` for a new key.
- `IDENTICAL` for the exact same pair, without a second insertion.
- `CONFLICT` for a different pair at an existing key, preserving the first.
- `FULL` when its configured capacity prevents insertion, without eviction.

The key deliberately excludes `requestDigest`. A seller cannot turn a changed
request digest into an independent stored call by re-signing the same request
ID. Changed seller or buyer attestations conflict, including attempts to replace
a disputed pair with an agreed one. Independent peer pairs can reuse request
IDs. Atomicity across processes and collector instances belongs to the backend;
a read-then-write implementation does not satisfy this contract.

The backend owns private access control, bounded total storage, capacity,
retention, concurrency and durability. This PR supplies only a synthetic memory
backend in tests, not deployable persistence. Deduplication lasts only while the
backend retains the key. Retention and replay tombstones must be specified
before external collection/public counting is enabled. No aggregate counter or
public metric is maintained by this API.

## Admission, cancellation and errors

Each collector instance admits at most four active calls without a queue.
Invalid submissions consume admission too. These are prototype policy bounds,
not measured production capacity or per-peer/Sybil protection. Callers must
supply future transport body-read limits, deadlines, authentication and abuse
protection; the already bounded body passed here is not a bounded network read.

The caller supplies cancellation; core creates no timers or clock. Cancellation
is checked before validation and before storage, and suppresses a successful
acknowledgement after cancellation. The backend must honor abort-before-commit.
If storage already committed before cancellation or acknowledgement failure,
there is no rollback promise. Retry only the identical receipt metadata, never
the prompt. The admission lease remains occupied until crypto/storage settles,
so an uncancellable backend cannot create unlimited abandoned work. A
permanently stalled backend can occupy the bounded pool and requires lifecycle
handling by its future host.

Results contain only `STORED` or `DUPLICATE`. Typed errors use the static
`RECEIPT_COLLECTOR_CODES` catalog. Conflicts and capacity are explicit; backend
exception text and input contents are never echoed. There is no logging,
external transmission, exporter activation, payment execution or prompt retry.

A future host must choose privacy/access and retention policies before exposing
collection. Complete receipts remain private to Gyblos under the existing
metrics decision; public per-seller/model aggregates and buyer totals require a
separate reviewed implementation. Local telemetry is not an independent source
of usage truth and is not a substitute for verified ingestion.
