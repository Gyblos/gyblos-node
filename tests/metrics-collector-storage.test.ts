// Exercises the metrics collector's D1 storage over SQLite: first versions, conflicts decided at write
// time (also under interleaved uploads), per-side first report times, rollback and no stored IP.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PUBLIC_RECEIPT_MERGES as MERGES } from '@gyblos/core/constants';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';
import { RECEIPT_VERDICTS } from '@gyblos/protocol/constants';
import {
  sellerReceiptDigest,
  signBuyerReceipt,
  signSellerReceipt,
} from '@gyblos/protocol/receipt';

import {
  COLLECTOR_CLIENT_IP,
  responseJson,
  signUpload,
  testCollector,
} from './support/metrics-collector';
import { createCollectorD1 } from './support/metrics-collector-d1';
import { buyerRecord } from './support/receipt-fixture';
import {
  buyerUpload,
  freePair,
  sellerUpload,
  T0,
} from './support/receipt-upload';

const TABLES = [
  'collector_envelopes',
  'collector_reports',
  'collector_receipts',
  'collector_conflicts',
  'collector_status_history',
] as const;

function nonce(byte: number) {
  return byte.toString(16).padStart(2, '0').repeat(16);
}

void test('first versions stay, a second seller record is the seller conflict, and the first report time per side is kept', async () => {
  const database = createCollectorD1();
  let now = T0;
  const { post } = testCollector(createD1Storage(database), { now: () => now });
  const { seller, buyer, receipt } = await freePair();

  const sellerOnly = sellerUpload(seller.nodeId, { seller: receipt.seller });
  await post(await signUpload(sellerOnly, seller.sign));
  now += 1000;
  const buyerReport = buyerUpload(buyer.nodeId, receipt);
  buyerReport.sentAt = now;
  await post(await signUpload(buyerReport, buyer.sign));
  now += 1000;
  const rewritten = structuredClone(receipt.seller.record);
  rewritten.usage.outputTokens += 1;
  const second = sellerUpload(seller.nodeId, {
    seller: await signSellerReceipt(rewritten, seller.sign),
  });
  second.nonce = nonce(2);
  second.sentAt = now;
  assert.equal((await post(await signUpload(second, seller.sign))).status, 200);

  const [stored] = database.rows(
    'SELECT status, output_tokens, seller_reported_at, buyer_reported_at FROM collector_receipts',
  );
  assert.deepEqual(
    { ...stored },
    {
      status: 'bilateral',
      output_tokens: receipt.seller.record.usage.outputTokens,
      seller_reported_at: T0,
      buyer_reported_at: T0 + 1000,
    },
  );
  assert.deepEqual(
    database
      .rows('SELECT merge FROM collector_conflicts')
      .map((row) => row.merge),
    [MERGES.SELLER_CONFLICT],
  );
  assert.deepEqual(
    database
      .rows('SELECT status FROM collector_status_history ORDER BY changed_at')
      .map((row) => row.status),
    ['seller-only', 'bilateral'],
  );
});

void test('a second buyer attestation is the buyer conflict and the first one stays', async () => {
  const database = createCollectorD1();
  const { post } = testCollector(createD1Storage(database));
  const { buyer, receipt } = await freePair();
  await post(await signUpload(buyerUpload(buyer.nodeId, receipt), buyer.sign));
  const record = receipt.seller.record;
  const disputed = buyerRecord(record, await sellerReceiptDigest(record));
  disputed.observed.outputTokens = record.usage.outputTokens + 1;
  disputed.verdict = RECEIPT_VERDICTS.DISPUTED;
  disputed.disputed = ['outputTokens'];
  const second = buyerUpload(buyer.nodeId, {
    seller: receipt.seller,
    buyer: await signBuyerReceipt(disputed, buyer.sign),
  });
  second.nonce = nonce(3);
  await post(await signUpload(second, buyer.sign));
  assert.equal(
    database.rows('SELECT status FROM collector_receipts')[0]!.status,
    'bilateral',
  );
  assert.deepEqual(
    database
      .rows('SELECT merge FROM collector_conflicts')
      .map((row) => row.merge),
    [MERGES.BUYER_CONFLICT],
  );
});

void test('interleaved uploads that both read an empty key still record the conflict', async () => {
  const database = createCollectorD1();
  const storage = createD1Storage(database);
  // Both uploads read before either commits.
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  const racing = {
    ...storage,
    async readEntries(keys: readonly string[]) {
      const found = await storage.readEntries(keys);
      reads += 1;
      if (reads === 2) release();
      await barrier;
      return found;
    },
  };
  const { post } = testCollector(racing);
  const { seller, receipt } = await freePair();
  const rewritten = structuredClone(receipt.seller.record);
  rewritten.usage.outputTokens += 1;
  const first = sellerUpload(seller.nodeId, { seller: receipt.seller });
  const second = sellerUpload(seller.nodeId, {
    seller: await signSellerReceipt(rewritten, seller.sign),
  });
  second.nonce = nonce(4);
  const results = await Promise.all([
    post(await signUpload(first, seller.sign)),
    post(await signUpload(second, seller.sign)),
  ]);
  assert.deepEqual(
    results.map((response) => response.status),
    [200, 200],
  );
  assert.equal(database.rows('SELECT * FROM collector_receipts').length, 1);
  assert.deepEqual(
    database
      .rows('SELECT merge FROM collector_conflicts')
      .map((row) => row.merge),
    [MERGES.SELLER_CONFLICT],
  );
  assert.equal(
    database.rows('SELECT * FROM collector_status_history').length,
    1,
  );
});

void test('a failure late in the batch rolls back every row, and replays store nothing', async () => {
  const database = createCollectorD1();
  const failing = {
    ...database,
    batch: (statements: Parameters<typeof database.batch>[0]) =>
      database.batch([
        ...statements,
        database.prepare('INSERT INTO missing_table VALUES (1)'),
      ]),
  };
  const { seller, receipt } = await freePair();
  const body = await signUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  const broken = await testCollector(createD1Storage(failing)).post(body);
  assert.deepEqual(await responseJson(broken), {
    status: 500,
    body: { error: 'COLLECTOR_INTERNAL_ERROR' },
  });
  for (const table of TABLES)
    assert.equal(database.rows(`SELECT * FROM ${table}`).length, 0, table);

  const { post } = testCollector(createD1Storage(database));
  assert.equal((await post(body)).status, 200);
  const replay = structuredClone(body.upload);
  replay.sentAt += 5;
  assert.equal((await post(await signUpload(replay, seller.sign))).status, 409);
  assert.equal(database.rows('SELECT * FROM collector_reports').length, 1);

  const dump = JSON.stringify(
    TABLES.map((table) => database.rows(`SELECT * FROM ${table}`)),
  );
  assert.equal(dump.includes(COLLECTOR_CLIENT_IP), false);
});
