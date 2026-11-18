# Usage receipts

A usage receipt is a content-free, signed record of one inference: which seller
and buyer, which model, how many tokens and bytes, how long it took, how it
ended and, when paid, the price and charge. The seller signs it and the buyer
countersigns it. Receipts never contain prompts, answers, keys or endpoint
addresses.

Free requests and [payment sessions](payment-sessions.md) produce receipts.
Per-request paid requests don't. The wire formats (`receipt/v1`, the receipt
channel and the upload envelopes) are owned by the
[protocol specification](../packages/protocol/SPEC.md).

## Lifecycle

1. **Sign.** After an execution, the seller builds a receipt from its own
   measurements and signs it with its node key. It stores this seller-only
   receipt in its role's private receipt store.
2. **Exchange.** The buyer fetches the seller's receipt over the receipt channel
   (`gyblos/receipt/1`, methods `receipt.get` and `receipt.confirm`). It checks
   the receipt against its own view of the execution, signs its observation and
   sends the pair back. Both roles store the countersigned pair.
3. **Upload.** In release builds, each role's uploader sends its pending
   receipts in signed batches to the metrics collector at
   `https://collector.gyblos.com/v1`.
4. **Classify.** The metrics collector verifies both signatures and counts each
   receipt as bilateral, disputed or seller-only, and free or paid. It never
   publishes individual receipts.

Receipt work runs beside inference and payments and never changes them. A
receipt failure never retries a prompt, blocks an answer or alters a payment.
Control queries and receipt calls have their own admission and don't hold a
generation slot.

## What leaves your machine

Release builds upload receipts with no setting to turn it off. They also upload
content-free telemetry observations, which `GYBLOS_OBSERVATIONS=off` turns off.
`GYBLOS_COLLECTOR_URL` points the uploader at another collector; it must be
`https`, or `http` on a loopback host. A build without a release version uploads
only when `GYBLOS_COLLECTOR_URL` is set, so tests and development stay offline.

The
[uploader section of metrics-collector.md](metrics-collector.md#uploader-nodes)
owns the exact fields sent, pacing, retries and failure handling. The receipt
privacy policy is in [public decisions](public-decisions.md).

## What a receipt proves

| Term                    | Meaning                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Seller-only             | Signed by the seller only. The buyer disconnected or never confirmed. It is never treated as countersigned. |
| Agreed (bilateral)      | Both node keys signed, and no comparable measurement differs.                                               |
| Disputed                | The buyer's known input or output token count, or output bytes, differ from the seller's.                   |
| `declared`, `recounted` | Whether the seller reports the engine's own token count or recounts it with the pinned tokenizer.           |
| Paid fields             | Prices, network, asset, charge and fee for a payment-session request.                                       |

A signature attests what its signer claims, not that the usage is true:

- "Agreed" means two node keys agreed. Node keys are free, so it doesn't show
  that two independent parties exist.
- A buyer's unknown token count stays `null`, even if the seller declared one.
  Different timings are kept but not disputed.
- A paid receipt doesn't prove settlement. A cumulative payment voucher is not a
  receipt either.
- Receipts are historical evidence and have no expiry.

## Construction API

`@gyblos/core/receipts` builds receipts. It is pure: no clock, randomness,
filesystem, transport, engine or payment. Callers inject their node signer.

- `buildFreeSellerReceipt(input)` validates a seller record with free pricing
  and zero amounts. `createFreeSellerReceipt(input, signer)` returns the signed
  seller-only envelope; the signer must match the seller NodeId.
- `buildFreeBuyerReceipt({ seller, context, observed })` verifies the seller's
  signature and requires the seller record to match the buyer's own
  `ReceiptExecutionContext` exactly: request ID, request digest, both NodeIds,
  owner, model selection, reasoning and streaming mode. The context comes from
  the buyer's verified execution, never from the received receipt.
  `createFreeBuyerReceipt(input, signer)` adds the buyer's signed observation.
- `buildPaidSellerReceipt`, `createPaidSellerReceipt`, `buildPaidBuyerReceipt`
  and `createPaidBuyerReceipt` do the same with a validated payment block
  (pricing, `amountAtomic`, `feeAtomic`).
- `receiptTextSizes(input, output)` returns UTF-8 byte and Unicode code-point
  counts and keeps no text.

Rules for callers:

- Supply measurements from the authenticated execution: actual usage, sizes,
  timing and outcome. Admission estimates and unused reservations are not usage.
  Never invent a count you don't have.
- The protocol requires known input and output token counts, so an attempt
  without them can't be attested.
- The buyer's digest covers the seller's signing bytes, not the request digest.
- Invalid signatures, context mismatches and malformed observations never reach
  the buyer's signer. Errors use static protocol codes and never echo input.

## Local store and upload cursor

`@gyblos/node/receipts` is each role's private receipt store, in the role's
`receipts/` directory. The seller daemon and the shared buyer (CLI and desktop
app) open it at startup. `gyblos seller status` shows its health, capacity and
failures.

- A saved receipt stays pending until the uploader's acknowledgement.
  `listPending(limit)` returns the oldest pending receipts with a fingerprint of
  each signed envelope. `markUploaded(cursor, confirmedAt)` is a
  compare-and-swap on that fingerprint.
- A later buyer confirmation keeps the original `storedAt` and returns the pair
  to pending, so an old seller-only acknowledgement can't acknowledge the pair.
- Pending capacity is 16,384 receipts or 64 MiB, reserving 4 KiB per receipt so
  a seller-only body can grow into its countersigned pair. At that limit new
  writes fail with `RECEIPT_STORAGE_FULL` and existing receipts are kept; the
  `rejectedWrites` counter counts failed write attempts.
- Only uploaded receipts are pruned, by the 256-receipt, 1 MiB and seven-day
  history limits.
- The store is an append-only private journal, synced before each write succeeds
  and compacted atomically within 128 MiB. A torn final line from a crash is
  discarded on the next write.

## Collector policy

`@gyblos/core/public-receipts` is the policy the metrics collector runs. It
verifies a receipt from either party (node signatures and cross-binding), keeps
a detached copy and classifies it. It refuses a buyer whose disputed fields
don't match its own observations.

Each receipt is keyed by seller NodeId, buyer NodeId and request ID. The first
accepted version stays stored and keeps counting:

- A buyer half completes a stored seller-only receipt.
- A different seller record under the same key, including a changed request
  digest, is a seller conflict. A second, different buyer attestation is a buyer
  conflict. A seller can't erase a buyer's dispute by signing again, and the
  conflict is evidence against the side that signed it.

The collector side (endpoints, storage, aggregates) is documented in
[metrics-collector.md](metrics-collector.md).

## Upload envelopes

Nodes upload with the signed "Receipt upload envelope v1" contract. The additive
`receipt-upload/v2` contract adds a buyer-declared reference to the exact paid
quote: `buildReceiptUploadOfferV2` projects an accepted quote to six facts plus
a SHA-256 reference, without endpoint addresses or the owner signature. Neither
the uploader nor the metrics collector uses v2. Its offer times come from the
seller's clock and stay buyer-reported claims, not proof of identity, settlement
or truthful metadata.

## Local receipt receiver

`apps/receipt-collector` is a standalone, loopback-only receiver for
countersigned free receipt pairs, for research collection with explicit buyer
consent. It is not the metrics collector, and buyers and sellers never upload to
it on their own. It composes the core policy below with a private file store.

### Receiver policy

`createPrivateReceiptCollector(store).collect(body, signal?)` in
`@gyblos/core/receipt-collector` takes one canonical JSON `{ seller, buyer }`
pair and checks:

- non-empty bytes, at most 4096 bytes and depth 16, strict UTF-8 and canonical
  JSON (no duplicate keys, trailing data or other whitespace);
- both node signatures, request and peer linkage, and the buyer's binding to the
  seller receipt digest;
- free pricing only, with a mandatory buyer attestation whose dispute fields
  match its real discrepancies.

Disputes are kept as disputes. The policy makes no RPC or index queries, checks
no owner–NodeId registry binding and applies no freshness rule. Each instance
admits at most four active calls with no queue; invalid submissions count too.
Results are `STORED` or `DUPLICATE`, and errors use the static
`RECEIPT_COLLECTOR_CODES`. Cancellation is checked before validation and before
storage; a commit that already happened is not rolled back, so retry only the
identical receipt, never the prompt.

The injected `PrivateReceiptStore.insert(entry, signal?)` must atomically return
`INSERTED`, `IDENTICAL`, `CONFLICT` (keeping the first pair) or `FULL` (without
eviction). The key is `[sellerNodeId, buyerNodeId, requestId]` and excludes the
request digest, so re-signing a request ID with a new digest conflicts instead
of counting twice.

### File stores

Two private file backends in `@gyblos/telemetry-file` implement that port. Only
the receiver opens them; normal node startup never does.

| Entry               | Behavior                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `receipt-store`     | `createReceiptFileStore` creates a new snapshot; `openReceiptFileStore` requires an existing valid one.                           |
| `retained-receipts` | Adds replay markers and records a `retentionMs` policy (at most seven days) that must match on reopen. Keeps bodies indefinitely. |

Both stores:

- hold at most 256 entries and a 1 MiB snapshot, return `FULL` at the limit and
  never evict, prune or reset;
- take one process lock for the store's lifetime, with at most four admitted
  writes (extra calls fail `BUSY`);
- re-verify every stored pair on open and refuse a corrupt snapshot or an
  orphaned stage file;
- write a full staged snapshot, sync it and rename it atomically, using 0700
  directories and 0600 files.

They are not encrypted, not rollback-resistant (a restored older snapshot goes
undetected), validated on POSIX only, and not a multi-host or hostile-process
defense. Ordinary macOS `fsync` doesn't guarantee power-loss durability.

### Standalone local receiver

The receiver binds only `127.0.0.1` and accepts exactly `POST /v1/receipts`.
There are no read, health, delete or admin routes.

- **Access.** Each grant has one buyer NodeId, one random 32-byte token (64
  lowercase hex characters) and `consent: true`. Obtain the buyer's consent
  before you add the grant; the flag records it but doesn't prove it. The
  receiver checks `Authorization: Bearer TOKEN` before reading the body, then
  requires the verified buyer attestation to match the grant. Changing grants
  needs a restart.
- **Requests.** `Content-Type: application/json`, no content encoding, at most
  4096 bytes. Seller-only, invalid or conflicting pairs are refused. Replies
  carry only `status: stored` or `status: duplicate`, or a static `COLLECTOR_*`
  code. A foreign `Host` gets an empty 421, and browser `Origin` or
  `Sec-Fetch-Site` requests are refused.
- **Limits.** 16 connections, four active requests, one active request per
  buyer, ten requests per buyer per minute, 120 per minute in total and 32
  grants. Every response closes its connection. The deadline is five seconds
  from complete headers.

Loopback is not authentication: another process of the same OS user can read the
configuration and reach the port.

### Start the receiver

1. Create a private configuration file (mode 0600, in a directory you control).
   Use placeholders only in shared examples:

   ```json
   {
     "version": 1,
     "path": "/ABSOLUTE/PATH/receipts.json",
     "create": true,
     "retentionMs": 604800000,
     "principals": [
       {
         "buyerNodeId": "BUYER_NODE_ID",
         "token": "RANDOM_64_HEX_TOKEN",
         "consent": true
       }
     ],
     "port": 4100
   }
   ```

   Replace `BUYER_NODE_ID` with the buyer's lowercase NodeId and
   `RANDOM_64_HEX_TOKEN` with a fresh random token. Set `create` to `true` only
   the first time, then to `false`. Never reuse a wallet or node key as a token,
   and never put tokens in command-line arguments, fixtures or logs.

2. Start the receiver with the file's absolute path:

   ```sh
   GYBLOS_COLLECTOR_CONFIG=/ABSOLUTE/PATH/collector.json pnpm --filter @gyblos/receipt-collector start
   ```

   The output is similar to the following:

   ```text
   {"ok":true,"loopback":true}
   ```

   A failure prints `{"ok":false,"code":"..."}` with a static code. The
   entrypoint takes no arguments and loads no `.env` file.

Programmatic hosts can call `startLocalCollector` with explicit options and own
its `close()`. Close stops admission and waits up to five seconds for admitted
work; it never breaks a lock.

## Related

- [Metrics collector](metrics-collector.md)
- [Payment sessions](payment-sessions.md)
- [Public decisions](public-decisions.md)
- [Protocol specification](../packages/protocol/SPEC.md)
