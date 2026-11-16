# Free receipt construction and policy

`@gyblos/core/receipts` constructs content-free `receipt/v1` attestations. It
imports protocol validation/signing only; no clock, randomness, filesystem,
transport, engine, payment or startup service is involved. Callers inject their
node signer. The existing receipt schema, signing domains and vectors are
unchanged. These functions are not connected to runtime execution.

## Seller

`buildFreeSellerReceipt(input)` takes `FreeSellerReceiptInput`: the seller
record's fields except version, pricing and amounts. It fixes version 1, free
pricing and both amounts to zero, rejects overrides/unknown fields and returns a
detached protocol-validated record. `createFreeSellerReceipt(input, signer)`
returns the signed seller-only envelope. The protocol self-verifies the signer
against the seller NodeId. Such an envelope remains unconfirmed.

The caller must supply measurements from the authenticated execution, including
its request digest, exact selection, actual usage, sizes, timing and terminal
outcome. Admission estimates and unused reservations are not usage. Preserve
`declared` versus `recounted` metering and nullable unknown reasoning tokens;
never manufacture unavailable counts. The protocol requires known input/output
token counts, so this API cannot attest an attempt for which they are unknown.
Failed/cancelled partial observations are accepted only under the existing
protocol invariants. This module cannot prove that a caller measured honestly.

`receiptTextSizes(input, output)` returns only UTF-8 bytes and Unicode
code-point counts. It retains no text. Use bounded execution text; this helper
is not a wire parser. Do not reuse telemetry character counts: that port
currently counts UTF-16 code units, whereas receipt/v1 specifies code points.

## Buyer

`buildFreeBuyerReceipt({ seller, context, observed })` first snapshots and
validates local context/observations, then verifies the seller signature. It
rejects paid receipts and requires exact equality with
`ReceiptExecutionContext`: request ID, execution request digest, seller/buyer
NodeIds, owner, complete model selection, reasoning and streaming mode. Context
must come from the buyer's independently verified execution, never from the
received receipt. Owner–NodeId policy, authenticated transport and quote
verification remain the caller's responsibility. Receipts are historical
evidence and have no expiry check.

The buyer digest references the canonical seller signing bytes, not the
execution request digest. Known unequal input/output token counts and output
bytes are disputed in protocol order. Unknown independent token counts stay
null, even if the seller declared counts. Different timing observations are
preserved but not disputed. `agreed` means no disagreement among available
comparable measurements; it does not establish independent token verification or
proof of execution.

`createFreeBuyerReceipt(input, signer)` returns the verified seller attestation
plus the buyer's separately signed observation. The buyer signer is checked
against the bound buyer NodeId. Invalid signatures, context mismatches and
malformed observations never reach the buyer signer. Protocol errors use
existing static codes and never include arbitrary input. There is no fallback or
retry here.

## Deliberately separate work

A future separate exchange needs its own transport contract; this module neither
registers a channel nor changes the free execution channels. No receipt
exchange, execution-channel change, event emission, persistence,
consent/configuration, collector or public aggregation is added. A disconnected
buyer can leave a seller-only receipt; it must never be treated as
countersigned. Receipt failures must be given explicit lifecycle semantics when
wiring execution; this module does not decide whether they can affect an already
delivered answer. Full receipts remain private; this API grants no permission to
publish or export them. Paid execution and v1 payment contracts remain
unchanged.

## Private ingestion policy

The separate
[private free-receipt collector policy](private-receipt-collector.md) validates
complete free pairs through an injected atomic storage port. It does not
activate collection, a backend, an exporter or seller/buyer startup wiring.

An optional private file implementation is available through
`@gyblos/telemetry-file/receipt-store`; its lifecycle, bounds and persistence
limitations are documented with the collector policy. It is not wired into
startup or external collection.

The public collector policy (`@gyblos/core/public-receipts`) verifies a
receipt/v1 or receipt/v2 from either party itself (node signatures and
cross-binding), keeps a detached copy, and classifies it as bilateral, disputed
or seller-only, free or paid, under the same key as the private collector. It
refuses a buyer whose disputed fields do not match its own observations.
Bilateral means two node keys agreed; it does not show that two independent
parties exist. A buyer half completes a stored seller-only receipt. A different
seller record under the same key (including a changed request digest) is a
seller conflict, and a second, different buyer attestation is a buyer conflict:
the first accepted version stays stored and keeps counting, so a seller cannot
erase a buyer's dispute by signing again, and the conflict is evidence against
the side that signed it. It is pure policy, not connected to any service; it
stores nothing and never publishes individual receipts. The loopback paired-free
collector above is unchanged and now shares the dispute, key and digest helpers
with it.

The signed batch format a node will use to hand its receipts and its own
timestamps to a collector is the protocol contract "Receipt upload envelope v1"
(`packages/protocol/SPEC.md`). It is a contract only: no uploader, schedule or
endpoint uses it yet.
