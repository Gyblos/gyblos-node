// Local HTTP admission, configuration and deadlines use only synthetic capabilities and temporary paths.
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { maintainCollector } from '@gyblos/receipt-collector/maintenance';
import {
  startLocalCollector,
  type CollectorOptions,
} from '@gyblos/receipt-collector/service';
import {
  collectorSettings,
  loadCollectorSettings,
} from '@gyblos/receipt-collector/settings';
import {
  createRetainedReceiptStore,
  openRetainedReceiptStore,
} from '@gyblos/telemetry-file/retained-receipts';

import { managedReceiptFixture } from './support/local-collector';
import { receiptBytes } from './support/receipt-collector';

const token = 'ab'.repeat(32);
function options(path: string, buyerNodeId: string): CollectorOptions {
  return {
    path,
    create: true,
    retentionMs: 100,
    port: 0,
    now: () => 1000,
    principals: [{ buyerNodeId, token, consent: true }],
  };
}
async function raw(
  url: string,
  body: Uint8Array,
  headers: Record<string, string>,
) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.on('data', (part: Buffer) => {
          text += part.toString();
        });
        response.once('end', () =>
          resolve({ status: response.statusCode!, text }),
        );
        response.once('error', reject);
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}
void test('local collector rejects Host rebinding, extra paths and read routes', async (context) => {
  const f = await managedReceiptFixture(context);
  const server = f.manage(
    await startLocalCollector(
      options(f.path, f.entry.receipt.seller.record.buyerNodeId),
    ),
  );
  assert.equal(
    (
      await raw(server.url, receiptBytes(f.entry.receipt), {
        host: 'synthetic.invalid',
      })
    ).status,
    421,
  );
  assert.equal(
    (await raw(server.url + '?extra=1', receiptBytes(f.entry.receipt), {}))
      .status,
    400,
  );
  assert.equal(
    (await fetch(server.url, { headers: { authorization: `Bearer ${token}` } }))
      .status,
    400,
  );
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).entries.length, 0);
});
void test('local collector applies buyer quotas and resets the window without restoring expired payloads', async (context) => {
  const f = await managedReceiptFixture(context);
  let now = 1000;
  const server = f.manage(
    await startLocalCollector({
      ...options(f.path, f.entry.receipt.seller.record.buyerNodeId),
      now: () => now,
    }),
  );
  for (let index = 0; index < 10; index++)
    assert.equal(
      (await raw(server.url, receiptBytes(f.entry.receipt), {})).status,
      200,
    );
  assert.equal(
    (await raw(server.url, receiptBytes(f.entry.receipt), {})).status,
    429,
  );
  now += 60000;
  const result = await raw(server.url, receiptBytes(f.entry.receipt), {});
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { status: 'duplicate' });
  assert.equal(
    JSON.parse(await readFile(f.path, 'utf8')).entries[0].receipt,
    null,
  );
});
void test('local collector cuts off a slow body and releases its buyer admission', async (context) => {
  const f = await managedReceiptFixture(context);
  const server = f.manage(
    await startLocalCollector({
      ...options(f.path, f.entry.receipt.seller.record.buyerNodeId),
      requestMs: 1000,
    }),
  );
  const first = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      const outgoing = request(
        server.url,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          let text = '';
          response.on('data', (part: Buffer) => {
            text += part.toString();
          });
          response.once('end', () =>
            resolve({ status: response.statusCode!, text }),
          );
          response.once('error', reject);
        },
      );
      outgoing.once('error', reject);
      outgoing.write('{');
    },
  );
  assert.equal(first.status, 504);
  assert.deepEqual(JSON.parse(first.text), { code: 'COLLECTOR_TIMEOUT' });
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).entries.length, 0);
  assert.equal(
    (await raw(server.url, receiptBytes(f.entry.receipt), {})).status,
    200,
  );
});
void test('local collector refuses overlapping requests for one buyer without queuing', async (context) => {
  const f = await managedReceiptFixture(context);
  const server = f.manage(
    await startLocalCollector(
      options(f.path, f.entry.receipt.seller.record.buyerNodeId),
    ),
  );
  const outgoing = request(
    server.url,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        expect: '100-continue',
      },
    },
    (response) => response.resume(),
  );
  outgoing.on('error', () => {});
  const ready = new Promise<void>((resolve) =>
    outgoing.once('continue', resolve),
  );
  outgoing.flushHeaders();
  await ready;
  try {
    assert.equal(
      (await raw(server.url, receiptBytes(f.entry.receipt), {})).status,
      429,
    );
  } finally {
    outgoing.destroy();
  }
  await server.close();
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).entries.length, 0);
});
void test('local collector requires consent, unique credentials and private strict configuration', async (context) => {
  const f = await managedReceiptFixture(context);
  const selected = options(f.path, f.entry.receipt.seller.record.buyerNodeId);
  for (const invalid of [
    { ...selected, principals: [] },
    { ...selected, host: '0.0.0.0' },
    {
      ...selected,
      principals: [{ ...selected.principals[0], consent: false }],
    },
    {
      ...selected,
      principals: [...selected.principals, ...selected.principals],
    },
  ])
    assert.throws(() => collectorSettings(invalid), {
      code: 'COLLECTOR_INVALID',
    });
  const path = join(f.directory, 'config.json');
  const { now: _clock, ...config } = selected;
  await writeFile(path, JSON.stringify({ version: 1, ...config }), {
    mode: 0o600,
  });
  assert.equal((await loadCollectorSettings(path)).principals.length, 1);
  await chmod(path, 0o644);
  await assert.rejects(loadCollectorSettings(path), {
    code: 'COLLECTOR_INVALID',
  });
  await chmod(path, 0o600);
  await writeFile(
    path,
    JSON.stringify({ version: 1, ...config, extra: 'synthetic-private' }),
  );
  await assert.rejects(loadCollectorSettings(path), {
    code: 'COLLECTOR_INVALID',
  });
});

void test('collector maintenance skips a full storage queue and works after normal writes drain', async (context) => {
  const f = await managedReceiptFixture(context);
  const store = f.manage(
    await createRetainedReceiptStore({
      path: f.path,
      retentionMs: 100,
      now: () => 1000,
      maxPending: 1,
    }),
  );
  const inserted = store.insert(f.entry);
  await assert.doesNotReject(maintainCollector(store));
  assert.equal(await inserted, 'inserted');
  await maintainCollector(store);
  assert.equal(await store.insert(f.other), 'inserted');
});
void test('collector startup releases storage when the clock fails during post-open initialization', async (context) => {
  const f = await managedReceiptFixture(context);
  let calls = 0;
  let failure: unknown;
  try {
    await startLocalCollector({
      ...options(f.path, f.entry.receipt.seller.record.buyerNodeId),
      now: () => {
        if (++calls === 3) throw new Error('Synthetic clock failure');
        return 1000;
      },
    });
  } catch (error) {
    failure = error;
  }
  const reopened = f.manage(
    await openRetainedReceiptStore({
      path: f.path,
      retentionMs: 100,
      now: () => 1000,
    }),
  );
  await reopened.close();
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'COLLECTOR_STORAGE');
});
