// Exercises private receipt ingestion with ephemeral signers and memory-only storage, never networking.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RECEIPT_COLLECTOR_CODES as CODES, RECEIPT_COLLECTOR_LIMITS, RECEIPT_COLLECTOR_STATUSES as STATUSES, RECEIPT_COLLECTOR_WRITES } from '@gyblos/core/constants';
import { createPrivateReceiptCollector, ReceiptCollectorError, type PrivateReceiptStore } from '@gyblos/core/receipt-collector';
import { RECEIPT_DISPUTE_FIELDS, RECEIPT_VERDICTS, OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import { signSellerReceipt, signBuyerReceipt, sellerReceiptDigest } from '@gyblos/protocol/receipt';

import { collectorPair, collectorStore, receiptBytes } from './support/receipt-collector';
import { receiptSigner } from './support/receipt-fixture';

void test('collector stores a verified free pair without returning private metadata', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore();
  assert.deepEqual(await createPrivateReceiptCollector(memory.store).collect(receiptBytes(pair)), { status: STATUSES.STORED });
  assert.equal(memory.entries.size, 1);
  assert.deepEqual([...memory.entries.values()][0]!.receipt, pair);
});
void test('collector treats concurrent identical pairs as one stored observation', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore();
  const collector = createPrivateReceiptCollector(memory.store);
  const results = await Promise.all([collector.collect(receiptBytes(pair)), collector.collect(receiptBytes(pair))]);
  assert.deepEqual(results.map((value) => value.status).sort(), [STATUSES.DUPLICATE, STATUSES.STORED].sort());
  assert.equal(memory.entries.size, 1);
});
void test('collector conflicts when the same execution changes its request digest', async () => {
  const { pair, seller, buyer } = await collectorPair();
  const record = { ...pair.seller.record, requestDigest: '77'.repeat(32) };
  const changed = { seller: await signSellerReceipt(record, seller.sign), buyer: await signBuyerReceipt({ ...pair.buyer.record, sellerReceiptDigest: await sellerReceiptDigest(record) }, buyer.sign) };
  const memory = collectorStore();
  const collector = createPrivateReceiptCollector(memory.store);
  await collector.collect(receiptBytes(pair));
  await assert.rejects(collector.collect(receiptBytes(changed)), { code: CODES.CONFLICT });
  assert.deepEqual([...memory.entries.values()][0]!.receipt, pair);
});
void test('collector preserves disputed pairs as disputed rather than agreed usage', async () => {
  const { pair } = await collectorPair(undefined, (value) => ({ ...value, observed: { ...value.observed, outputTokens: 9 }, verdict: RECEIPT_VERDICTS.DISPUTED, disputed: [RECEIPT_DISPUTE_FIELDS.OUTPUT_TOKENS] }));
  const memory = collectorStore();
  await createPrivateReceiptCollector(memory.store).collect(receiptBytes(pair));
  assert.equal([...memory.entries.values()][0]!.receipt.buyer.record.verdict, RECEIPT_VERDICTS.DISPUTED);
});
void test('collector refuses a signed but false agreed verdict before storage', async () => {
  const { pair } = await collectorPair(undefined, (value) => ({ ...value, observed: { ...value.observed, outputTokens: 9 } }));
  const memory = collectorStore();
  await assert.rejects(createPrivateReceiptCollector(memory.store).collect(receiptBytes(pair)), { code: CODES.DISPUTE });
  assert.equal(memory.calls(), 0);
});
void test('collector preserves unknown buyer token counts without inventing usage', async () => {
  const { pair } = await collectorPair(undefined, (value) => ({ ...value, observed: { ...value.observed, inputTokens: null, outputTokens: null } }));
  const memory = collectorStore();
  await createPrivateReceiptCollector(memory.store).collect(receiptBytes(pair));
  assert.equal([...memory.entries.values()][0]!.receipt.buyer.record.observed.inputTokens, null);
});
void test('collector rejects paid receipts even if the signed charge is zero', async () => {
  const { pair } = await collectorPair((value) => ({ ...value, pricing: { kind: OFFER_PRICING_KINDS.PAID, prices: { inputAtomicPerMtok: '1', outputAtomicPerMtok: '1' }, network: 'solana:synthetic', asset: value.owner } }));
  const memory = collectorStore();
  await assert.rejects(createPrivateReceiptCollector(memory.store).collect(receiptBytes(pair)), { code: CODES.NOT_FREE });
  assert.equal(memory.calls(), 0);
});
void test('collector requires a buyer attestation, not a seller-only observation', async () => {
  const { pair } = await collectorPair();
  await assert.rejects(createPrivateReceiptCollector(collectorStore().store).collect(receiptBytes({ seller: pair.seller })), { code: CODES.PAIR_REQUIRED });
});
void test('collector rejects a forged seller signature without storage', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore();
  await assert.rejects(createPrivateReceiptCollector(memory.store).collect(receiptBytes({ ...pair, seller: { ...pair.seller, signature: '00'.repeat(64) } })), { code: CODES.SIGNATURE });
  assert.equal(memory.calls(), 0);
});
void test('collector rejects a forged buyer signature without storage', async () => {
  const { pair } = await collectorPair();
  await assert.rejects(createPrivateReceiptCollector(collectorStore().store).collect(receiptBytes({ ...pair, buyer: { ...pair.buyer, signature: '00'.repeat(64) } })), { code: CODES.SIGNATURE });
});
void test('collector rejects a valid buyer signature bound to another seller receipt', async () => {
  const { pair, buyer } = await collectorPair();
  pair.buyer = await signBuyerReceipt({ ...pair.buyer.record, sellerReceiptDigest: '77'.repeat(32) }, buyer.sign);
  await assert.rejects(createPrivateReceiptCollector(collectorStore().store).collect(receiptBytes(pair)), { code: CODES.BINDING });
});
void test('collector rejects unknown fields before writing private storage', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore();
  await assert.rejects(createPrivateReceiptCollector(memory.store).collect(receiptBytes({ ...pair, extra: true })), { code: CODES.INVALID });
  assert.equal(memory.calls(), 0);
});
void test('collector rejects noncanonical JSON and duplicate keys', async () => {
  const { pair } = await collectorPair();
  const collector = createPrivateReceiptCollector(collectorStore().store);
  await assert.rejects(collector.collect(new TextEncoder().encode(JSON.stringify(pair))), { code: CODES.INVALID });
  await assert.rejects(collector.collect(new TextEncoder().encode('{"seller":null,"seller":null}')), { code: CODES.INVALID });
});
void test('collector rejects invalid UTF8 and excessive depth', async () => {
  const collector = createPrivateReceiptCollector(collectorStore().store);
  await assert.rejects(collector.collect(Uint8Array.of(255)), { code: CODES.INVALID });
  await assert.rejects(collector.collect(new TextEncoder().encode('['.repeat(RECEIPT_COLLECTOR_LIMITS.depth + 1) + '0' + ']'.repeat(RECEIPT_COLLECTOR_LIMITS.depth + 1))), { code: CODES.LIMIT });
});
void test('collector rejects oversized input before storage', async () => {
  const memory = collectorStore();
  await assert.rejects(createPrivateReceiptCollector(memory.store).collect(new Uint8Array(RECEIPT_COLLECTOR_LIMITS.bytes + 1)), { code: CODES.LIMIT });
  assert.equal(memory.calls(), 0);
});
void test('collector checks cancellation before any storage call', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createPrivateReceiptCollector(memory.store).collect(receiptBytes(pair), controller.signal), { code: CODES.CANCELLED });
  assert.equal(memory.calls(), 0);
});
void test('collector has no queue and releases admission when backend work settles', async () => {
  const { pair } = await collectorPair();
  let release = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  const store: PrivateReceiptStore = { async insert() { entered++; await wait; return RECEIPT_COLLECTOR_WRITES.IDENTICAL; } };
  const collector = createPrivateReceiptCollector(store);
  const pending = Array.from({ length: RECEIPT_COLLECTOR_LIMITS.active }, () => collector.collect(receiptBytes(pair)));
  const settled = Promise.allSettled(pending);
  try { await assert.rejects(collector.collect(receiptBytes(pair)), { code: CODES.BUSY }); }
  finally { release(); }
  assert.ok((await settled).every((result) => result.status === 'fulfilled'));
  assert.equal(entered, RECEIPT_COLLECTOR_LIMITS.active);
  assert.deepEqual(await collector.collect(receiptBytes(pair)), { status: STATUSES.DUPLICATE });
});
void test('collector maps storage failure to a static typed error and releases admission', async () => {
  const { pair } = await collectorPair();
  const collector = createPrivateReceiptCollector({ async insert() { throw new Error('Synthetic backend failure'); } });
  for (let index = 0; index <= RECEIPT_COLLECTOR_LIMITS.active; index++)
    await assert.rejects(collector.collect(receiptBytes(pair)), (error: unknown) => error instanceof ReceiptCollectorError && error.code === CODES.STORAGE && error.message === CODES.STORAGE);
});
void test('collector reports backend capacity without deleting or evicting observations', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore(0);
  await assert.rejects(createPrivateReceiptCollector(memory.store).collect(receiptBytes(pair)), { code: CODES.LIMIT });
  assert.equal(memory.entries.size, 0);
});
void test('collector snapshots caller bytes before asynchronous verification', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore();
  const bytes = receiptBytes(pair);
  const result = createPrivateReceiptCollector(memory.store).collect(bytes);
  bytes.fill(0);
  assert.deepEqual(await result, { status: STATUSES.STORED });
});
void test('collector isolates reused request IDs belonging to different signers', async () => {
  const { pair, buyer } = await collectorPair();
  const other = receiptSigner();
  const record = { ...pair.seller.record, sellerNodeId: other.nodeId };
  const changed = {
    seller: await signSellerReceipt(record, other.sign),
    buyer: await signBuyerReceipt({ ...pair.buyer.record, sellerNodeId: other.nodeId, sellerReceiptDigest: await sellerReceiptDigest(record) }, buyer.sign),
  };
  const memory = collectorStore();
  const collector = createPrivateReceiptCollector(memory.store);
  await collector.collect(receiptBytes(pair));
  await collector.collect(receiptBytes(changed));
  assert.equal(memory.entries.size, 2);
});
