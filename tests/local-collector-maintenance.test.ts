// Storage-port backpressure is injected without modifying handlers, and all HTTP stays on synthetic loopback.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';

import { maintainCollector } from '@gyblos/receipt-collector/maintenance';
import {
  startLocalCollector,
  type CollectorStorage,
} from '@gyblos/receipt-collector/service';
import {
  RECEIPT_FILE_CODES,
  ReceiptFileError,
} from '@gyblos/telemetry-file/receipt-store';
import {
  createRetainedReceiptStore,
  openRetainedReceiptStore,
  type RetainedReceiptStore,
} from '@gyblos/telemetry-file/retained-receipts';

import { managedReceiptFixture } from './support/local-collector';
import { collectorPair, receiptBytes } from './support/receipt-collector';

for (const code of [RECEIPT_FILE_CODES.BUSY, RECEIPT_FILE_CODES.UNAVAILABLE])
  void test(`local collector sweep ${code} has the correct admission effect after four buyers drain`, async (context) => {
    const f = await managedReceiptFixture(context);
    const pairs = [f.entry.receipt];
    for (let index = 0; index < 3; index++)
      pairs.push((await collectorPair()).pair);
    const principals = pairs.map((pair, index) => ({
      buyerNodeId: pair.seller.record.buyerNodeId,
      token: (index + 1).toString(16).padStart(2, '0').repeat(32),
      consent: true as const,
    }));
    let held = 0;
    let resumed = false;
    let release = () => {};
    let swept = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tick = new Promise<void>((resolve) => {
      swept = resolve;
    });
    const storage: CollectorStorage = {
      open: openRetainedReceiptStore,
      create: async (settings) => {
        const store = await createRetainedReceiptStore(settings);
        const wrapped: RetainedReceiptStore = {
          async insert(entry, signal) {
            if (!resumed) {
              held++;
              await gate;
            }
            return store.insert(entry, signal);
          },
          async sweep() {
            if (held === 4 && !resumed) {
              swept();
              throw new ReceiptFileError(code);
            }
            await store.sweep();
          },
          close: () => store.close(),
        };
        return wrapped;
      },
    };
    const server = f.manage(
      await startLocalCollector(
        {
          path: f.path,
          create: true,
          retentionMs: 1000,
          now: () => 1000,
          port: 0,
          principals,
        },
        storage,
      ),
    );
    const send = (index: number) =>
      fetch(server.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${principals[index]!.token}`,
          'content-type': 'application/json',
        },
        body: Buffer.from(receiptBytes(pairs[index])),
      });
    const pending = pairs.map((_pair, index) => send(index));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        tick,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('Maintenance did not observe the bounded pool')),
            10000,
          );
        }),
      ]);
      resumed = true;
      release();
      const responses = await Promise.all(pending);
      assert.ok(responses.every((response) => response.status === 200));
      assert.equal(
        (await send(0)).status,
        code === RECEIPT_FILE_CODES.BUSY ? 200 : 503,
      );
    } finally {
      clearTimeout(timer);
      resumed = true;
      release();
      await Promise.allSettled(pending);
    }
  });
void test('local collector authenticates an unfinished body before parsing it', async (context) => {
  const f = await managedReceiptFixture(context);
  const token = 'ab'.repeat(32);
  const server = f.manage(
    await startLocalCollector({
      path: f.path,
      create: true,
      retentionMs: 1000,
      now: () => 1000,
      requestMs: 1000,
      port: 0,
      principals: [
        {
          buyerNodeId: f.entry.receipt.seller.record.buyerNodeId,
          token,
          consent: true,
        },
      ],
    }),
  );
  const response = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      const outgoing = request(
        server.url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': '4096',
          },
        },
        (incoming) => {
          let text = '';
          incoming.on('data', (part: Buffer) => {
            text += part.toString();
          });
          incoming.once('end', () =>
            resolve({ status: incoming.statusCode!, text }),
          );
          incoming.once('error', reject);
        },
      );
      outgoing.once('error', reject);
      outgoing.write('{');
    },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.text), {
    code: 'COLLECTOR_UNAUTHORIZED',
  });
});
void test('collector maintenance propagates genuine storage failures', async () => {
  await assert.rejects(
    maintainCollector({
      sweep: async () => {
        throw new ReceiptFileError(RECEIPT_FILE_CODES.UNAVAILABLE);
      },
    }),
    { code: RECEIPT_FILE_CODES.UNAVAILABLE },
  );
});
