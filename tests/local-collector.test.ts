// Exercises only a locally bound collector with synthetic credentials, receipts and temporary private storage.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import test from 'node:test';

import { LOCAL_COLLECTOR_CODES } from '@gyblos/receipt-collector/constants';
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
function decodedBody(head: string, encoded: string) {
  if (!head.toLowerCase().includes('\r\ntransfer-encoding: chunked'))
    return encoded;
  let body = '';
  let rest = encoded;
  while (rest) {
    const end = rest.indexOf('\r\n');
    if (end < 0) return body;
    const length = Number.parseInt(rest.slice(0, end), 16);
    if (!Number.isFinite(length) || length === 0) return body;
    const start = end + 2;
    if (rest.length < start + length) return body;
    body += rest.slice(start, start + length);
    rest = rest.slice(start + length + 2);
  }
  return body;
}
async function postChunked(url: string, chunks: readonly Uint8Array[]) {
  const target = new URL(url);
  const socket = createConnection({
    host: target.hostname,
    port: Number(target.port),
  });
  const received: Buffer[] = [];
  socket.on('data', (part) => received.push(Buffer.from(part)));
  const done = new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('close', () => resolve());
  });
  await once(socket, 'connect');
  socket.write(
    `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
  );
  for (const chunk of chunks) {
    socket.write(`${chunk.length.toString(16)}\r\n`);
    socket.write(chunk);
    socket.write('\r\n');
  }
  socket.end('0\r\n\r\n');
  await done;
  const raw = Buffer.concat(received).toString('utf8');
  const [head = '', body = ''] = raw.split('\r\n\r\n');
  const status = Number(/^HTTP\/1\.1 ([0-9]+)/.exec(head)?.[1]);
  return { status, body: decodedBody(head, body) };
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
void test('local collector answers a chunked oversize body with 413', async (context) => {
  const f = await fixture(context);
  const chunk = new Uint8Array(1024);
  const response = await postChunked(
    f.server.url,
    Array.from({ length: 1024 }, () => chunk),
  );
  assert.equal(response.status, 413);
  assert.deepEqual(JSON.parse(response.body), {
    code: LOCAL_COLLECTOR_CODES.LIMIT,
  });
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
