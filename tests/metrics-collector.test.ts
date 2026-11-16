// Exercises the metrics collector app over memory and SQLite-backed D1 storage with ephemeral signers:
// admission, verification, the clock window, replay, merges by side and fail-closed configuration.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PUBLIC_RECEIPT_MERGES as MERGES } from '@gyblos/core/constants';
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import {
  COLLECTOR_ERRORS,
  COLLECTOR_LIMITERS,
  COLLECTOR_ROUTES,
} from '@gyblos/metrics-collector/constants';
import {
  createMemoryStorage,
  type CollectorStorage,
} from '@gyblos/metrics-collector/storage';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  signReceiptUpload,
  type ReceiptUploadV1,
} from '@gyblos/protocol/receipt-upload';

import { createCollectorD1 } from './support/metrics-collector-d1';
import {
  buyerUpload,
  freePair,
  sellerUpload,
  T0,
} from './support/receipt-upload';

const ORIGIN = 'https://collector.test';
const CLIENT_IP = '203.0.113.7';

function limiter(allow = true) {
  const keys: string[] = [];
  return {
    keys,
    limit({ key }: { key: string }) {
      keys.push(key);
      return Promise.resolve({ success: allow });
    },
  };
}

function collector(
  storage: CollectorStorage | undefined,
  options: { ip?: boolean; node?: boolean; now?: number } = {},
) {
  const ip = limiter(options.ip ?? true);
  const node = limiter(options.node ?? true);
  const app = createMetricsCollector({
    storage,
    limiters: {
      [COLLECTOR_LIMITERS.IP]: ip,
      [COLLECTOR_LIMITERS.NODE]: node,
    },
    now: () => options.now ?? T0,
  });
  const post = (body: unknown, origin = ORIGIN) =>
    app.request(`${origin}${COLLECTOR_ROUTES.RECEIPTS}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': CLIENT_IP,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, post, ip, node };
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as unknown };
}

async function signed(
  upload: ReceiptUploadV1,
  sign: (b: Uint8Array) => Promise<Uint8Array>,
) {
  return signReceiptUpload(upload, sign);
}

void test('a seller upload is accepted, stored once and reported per side', async () => {
  const memory = createMemoryStorage();
  const { post } = collector(memory.storage);
  const { seller, buyer, receipt } = await freePair();

  const first = await json(
    await post(await signed(sellerUpload(seller.nodeId, receipt), seller.sign)),
  );
  assert.deepEqual(first, {
    status: 200,
    body: { receivedAt: T0, items: [{ merge: MERGES.INSERT }] },
  });

  const buyerReport = buyerUpload(buyer.nodeId, receipt);
  const second = await json(await post(await signed(buyerReport, buyer.sign)));
  assert.deepEqual(second.body, {
    receivedAt: T0,
    items: [{ merge: MERGES.IDENTICAL }],
  });
  assert.equal(memory.entries.size, 1);
  assert.equal(memory.reports.length, 2);
  const firstReports = [...memory.firstReports.values()][0]!;
  assert.deepEqual(Object.keys(firstReports).sort(), [
    P2P_ROLES.BUYER,
    P2P_ROLES.SELLER,
  ]);
  // The buyer's own claims are kept with its report.
  assert.equal(memory.reports[1]!.startedAt, buyerReport.items[0]!.startedAt);
});

void test('a buyer half completes a seller-only receipt', async () => {
  const memory = createMemoryStorage();
  const { post } = collector(memory.storage);
  const { seller, buyer, receipt } = await freePair();
  const sellerOnly = sellerUpload(seller.nodeId, { seller: receipt.seller });
  await post(await signed(sellerOnly, seller.sign));
  const result = await json(
    await post(await signed(buyerUpload(buyer.nodeId, receipt), buyer.sign)),
  );
  assert.deepEqual(result.body, {
    receivedAt: T0,
    items: [{ merge: MERGES.UPGRADE }],
  });
});

void test('uploads outside the clock window get the collector time to correct and resend', async () => {
  const { seller, receipt } = await freePair();
  const { post } = collector(createMemoryStorage().storage, {
    now: T0 + 3_600_000,
  });
  assert.deepEqual(
    await json(
      await post(
        await signed(sellerUpload(seller.nodeId, receipt), seller.sign),
      ),
    ),
    {
      status: 409,
      body: {
        error: COLLECTOR_ERRORS.STALE_UPLOAD,
        serverTime: T0 + 3_600_000,
      },
    },
  );
});

void test('the same envelope twice is a replay and changes nothing', async () => {
  const memory = createMemoryStorage();
  const { post } = collector(memory.storage);
  const { seller, receipt } = await freePair();
  const body = await signed(sellerUpload(seller.nodeId, receipt), seller.sign);
  assert.equal((await post(body)).status, 200);
  assert.deepEqual(await json(await post(body)), {
    status: 409,
    body: { error: COLLECTOR_ERRORS.REPLAYED_UPLOAD },
  });
  assert.equal(memory.reports.length, 1);
});

void test('bad signatures, non-party uploads and malformed bodies get static codes', async () => {
  const { post } = collector(createMemoryStorage().storage);
  const { seller, receipt } = await freePair();
  const body = await signed(sellerUpload(seller.nodeId, receipt), seller.sign);

  const tampered = structuredClone(body);
  tampered.upload.items[0]!.storedAt = 1;
  assert.deepEqual((await json(await post(tampered))).body, {
    error: COLLECTOR_ERRORS.INVALID_SIGNATURE,
  });
  assert.deepEqual((await json(await post('{"upload":'))).body, {
    error: COLLECTOR_ERRORS.INVALID_UPLOAD,
  });
  assert.equal((await post('x'.repeat(400_000))).status, 413);
});

void test('per-node admission runs before any signature work', async () => {
  const { post, node } = collector(createMemoryStorage().storage, {
    node: false,
  });
  const { seller, receipt } = await freePair();
  const body = await signed(sellerUpload(seller.nodeId, receipt), seller.sign);
  body.signature = '00'.repeat(64);
  assert.deepEqual(await json(await post(body)), {
    status: 429,
    body: { error: COLLECTOR_ERRORS.RATE_LIMITED },
  });
  assert.deepEqual(node.keys, [seller.nodeId]);
});

void test('missing storage or limiters fail closed, and plain http is refused', async () => {
  const { post } = collector(undefined);
  assert.equal((await post({})).status, 503);
  const memory = createMemoryStorage();
  const limited = collector(memory.storage, { ip: false });
  assert.equal((await limited.post({})).status, 429);
  assert.deepEqual(limited.ip.keys, [CLIENT_IP]);
  assert.deepEqual(
    (
      await json(
        await collector(memory.storage).post({}, 'http://collector.test'),
      )
    ).body,
    { error: COLLECTOR_ERRORS.HTTPS_REQUIRED },
  );
});

void test('D1 storage keeps first versions, conflicts and per-side report times, never the IP', async () => {
  const database = createCollectorD1();
  const { post } = collector(createD1Storage(database));
  const { seller, buyer, receipt } = await freePair();

  await post(
    await signed(
      sellerUpload(seller.nodeId, { seller: receipt.seller }),
      seller.sign,
    ),
  );
  const buyerResult = await json(
    await post(await signed(buyerUpload(buyer.nodeId, receipt), buyer.sign)),
  );
  assert.deepEqual(buyerResult.body, {
    receivedAt: T0,
    items: [{ merge: MERGES.UPGRADE }],
  });

  // The seller signs a different record for the same request: evidence against it, nothing replaced.
  const rewritten = structuredClone(receipt.seller.record);
  rewritten.usage.outputTokens += 1;
  const { signSellerReceipt } = await import('@gyblos/protocol/receipt');
  const second = sellerUpload(seller.nodeId, {
    seller: await signSellerReceipt(rewritten, seller.sign),
  });
  second.nonce = 'cd'.repeat(16);
  const conflict = await json(await post(await signed(second, seller.sign)));
  assert.deepEqual(conflict.body, {
    receivedAt: T0,
    items: [{ merge: MERGES.SELLER_CONFLICT }],
  });

  const [stored] = database.rows(
    'SELECT status, output_tokens, buyer_digest IS NOT NULL AS paired, seller_reported_at, buyer_reported_at FROM collector_receipts',
  );
  assert.deepEqual(
    { ...stored },
    {
      status: 'bilateral',
      output_tokens: receipt.seller.record.usage.outputTokens,
      paired: 1,
      seller_reported_at: T0,
      buyer_reported_at: T0,
    },
  );
  assert.equal(database.rows('SELECT * FROM collector_conflicts').length, 1);
  assert.equal(database.rows('SELECT * FROM collector_reports').length, 3);
  assert.equal(database.rows('SELECT * FROM collector_envelopes').length, 3);

  // Replays are refused by the unique (uploader, nonce) constraint inside the transaction.
  assert.equal((await post(await signed(second, seller.sign))).status, 409);
  assert.equal(database.rows('SELECT * FROM collector_reports').length, 3);

  const dump = JSON.stringify(
    [
      'collector_envelopes',
      'collector_reports',
      'collector_receipts',
      'collector_conflicts',
    ].map((table) => database.rows(`SELECT * FROM ${table}`)),
  );
  assert.equal(dump.includes(CLIENT_IP), false);
});
