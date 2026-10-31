// Exercises only a locally bound collector with synthetic credentials, receipts and temporary private storage.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  startLocalCollector,
  type CollectorOptions,
} from '@gyblos/receipt-collector/service';

import { managedReceiptFixture } from './support/local-collector';
import { receiptBytes } from './support/receipt-collector';

const token = 'ab'.repeat(32);
async function fixture(context: Parameters<typeof managedReceiptFixture>[0]) {
  const f = await managedReceiptFixture(context);
  const options: CollectorOptions = {
    path: f.path,
    create: true,
    retentionMs: 100,
    now: () => 1000,
    port: 0,
    principals: [
      {
        buyerNodeId: f.entry.receipt.seller.record.buyerNodeId,
        token,
        consent: true,
      },
    ],
  };
  const server = await startLocalCollector(options);
  f.manage(server);
  return { ...f, options, server };
}
async function submit(
  url: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: Buffer.from(body),
  });
}
void test('local collector stores and deduplicates only the authorized buyer pair', async (context) => {
  const f = await fixture(context);
  let response = await submit(f.server.url, receiptBytes(f.entry.receipt));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'stored' });
  response = await submit(f.server.url, receiptBytes(f.entry.receipt));
  assert.deepEqual(await response.json(), { status: 'duplicate' });
  assert.ok((await readFile(f.path, 'utf8')).includes(f.entry.fingerprint));
});
void test('local collector rejects missing credentials and browser-origin requests before ingestion', async (context) => {
  const f = await fixture(context);
  assert.equal(
    (
      await submit(f.server.url, receiptBytes(f.entry.receipt), {
        authorization: '',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await submit(f.server.url, receiptBytes(f.entry.receipt), {
        origin: 'https://synthetic.invalid',
      })
    ).status,
    403,
  );
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).entries.length, 0);
});
void test('local collector refuses valid signed pairs outside the credential buyer scope', async (context) => {
  const f = await fixture(context);
  const options: CollectorOptions = {
    ...f.options,
    path: f.path + '-scoped',
    principals: [{ buyerNodeId: '12'.repeat(32), token, consent: true }],
  };
  const other = await startLocalCollector(options);
  f.manage(other);
  assert.equal(
    (await submit(other.url, receiptBytes(f.entry.receipt))).status,
    403,
  );
  assert.equal(
    JSON.parse(await readFile(options.path, 'utf8')).entries.length,
    0,
  );
});
void test('local collector bounds bytes and refuses noncanonical input without reflecting it', async (context) => {
  const f = await fixture(context);
  assert.equal((await submit(f.server.url, new Uint8Array(4097))).status, 413);
  const response = await submit(
    f.server.url,
    new TextEncoder().encode('synthetic-private-invalid'),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes('synthetic-private'), false);
});
void test('local collector reopens retained history and requires explicit configuration consent', async (context) => {
  const f = await fixture(context);
  assert.equal(
    (await submit(f.server.url, receiptBytes(f.entry.receipt))).status,
    200,
  );
  await f.server.close();
  const reopened = await startLocalCollector({ ...f.options, create: false });
  f.manage(reopened);
  assert.deepEqual(
    await (await submit(reopened.url, receiptBytes(f.entry.receipt))).json(),
    { status: 'duplicate' },
  );
  await assert.rejects(
    startLocalCollector({
      ...f.options,
      path: f.path + '-invalid',
      principals: [],
    }),
    { code: 'COLLECTOR_INVALID' },
  );
});
