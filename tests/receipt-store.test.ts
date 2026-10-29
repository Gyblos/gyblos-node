// Validates private bounded receipt snapshots in isolated temporary role homes; no real keys or journals.
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { receiptPathsIn } from '@gyblos/config';
import { createFreeBuyerReceipt } from '@gyblos/core/receipts';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { openReceiptStore } from '@gyblos/node/receipts';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { signSellerReceipt } from '@gyblos/protocol/receipt';

import { receiptChannelFixture } from './support/receipt-channel';

async function fixture() {
  const f = await receiptChannelFixture();
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'gyblos-receipts-'),
  );
  const environment = { GYBLOS_HOME: root };
  let now = 1700000000100;
  const options = {
    environment,
    role: P2P_ROLES.SELLER,
    nodeId: f.seller.nodeId,
    now: () => now,
    maxEntries: 2,
    retentionMs: 1000,
  };
  const key = {
    executionRequestId: f.record.requestId,
    requestDigest: f.record.requestDigest,
    buyerNodeId: f.record.buyerNodeId,
    sellerNodeId: f.record.sellerNodeId,
  };
  return {
    ...f,
    root,
    environment,
    options,
    key,
    paths: receiptPathsIn(environment, P2P_ROLES.SELLER),
    advance: (n: number) => {
      now += n;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
void test('receipt snapshots persist privately across store instances and bind the role identity', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    assert.deepEqual(
      await openReceiptStore(f.options).load(
        f.key,
        new AbortController().signal,
      ),
      f.envelope,
    );
    if (process.platform !== 'win32') {
      assert.equal((await lstat(f.paths.directory)).mode & 0o777, 0o700);
      assert.equal((await lstat(f.paths.state)).mode & 0o777, 0o600);
    }
    await assert.rejects(
      openReceiptStore({ ...f.options, nodeId: 'ff'.repeat(32) }).load(
        f.key,
        new AbortController().signal,
      ),
    );
  } finally {
    await f.close();
  }
});
void test('receipt storage rejects unknown content and tampered signatures without replacing valid data', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const before = await readFile(f.paths.state, 'utf8');
    await assert.rejects(
      store.put({ ...f.envelope, prompt: 'synthetic-private-marker' }),
    );
    await assert.rejects(
      store.put({
        seller: { ...f.envelope.seller, signature: '00'.repeat(64) },
      }),
    );
    assert.equal(await readFile(f.paths.state, 'utf8'), before);
  } finally {
    await f.close();
  }
});
void test('receipt snapshot expires old records and evicts oldest only at the configured entry bound', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    for (const n of [2, 3]) {
      f.advance(1);
      await store.put({
        seller: await signSellerReceipt(
          { ...f.record, requestId: n.toString(16).padStart(32, '0') },
          f.seller.sign,
        ),
      });
    }
    assert.equal(
      await store.load(f.key, new AbortController().signal),
      undefined,
    );
    f.advance(1000);
    assert.equal(
      await store.load(
        { ...f.key, executionRequestId: '3'.padStart(32, '0') },
        new AbortController().signal,
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});
void test('receipt confirmation is atomic and rejects a conflicting buyer attestation', async () => {
  const f = await fixture();
  try {
    const a = openReceiptStore(f.options);
    const b = openReceiptStore(f.options);
    await a.put(f.envelope);
    assert.equal(
      await a.confirm(f.confirm.params.receipt, new AbortController().signal),
      true,
    );
    assert.equal(
      await b.confirm(f.confirm.params.receipt, new AbortController().signal),
      true,
    );
    const other = await createFreeBuyerReceipt(
      {
        seller: f.envelope.seller,
        context: f.context,
        observed: {
          ...f.confirm.params.receipt.buyer.record.observed,
          outputTokens: 6,
        },
      },
      f.buyer.sign,
    );
    assert.ok(other.buyer);
    assert.equal(
      await b.confirm(
        { ...other, buyer: other.buyer },
        new AbortController().signal,
      ),
      false,
    );
    assert.deepEqual(
      await a.load(f.key, new AbortController().signal),
      f.confirm.params.receipt,
    );
  } finally {
    await f.close();
  }
});
void test('receipt storage refuses unsafe files, oversized data and cancellation', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(store.put(f.envelope, abort.signal));
    if (process.platform !== 'win32') {
      await chmod(f.paths.state, 0o644);
      await assert.rejects(store.load(f.key, new AbortController().signal), {
        code: NODE_ERROR_CODES.RECEIPT_STORAGE_UNAVAILABLE,
      });
      await chmod(f.paths.state, 0o600);
    }
    await writeFile(f.paths.state, ' '.repeat(1_048_577));
    await assert.rejects(store.load(f.key, new AbortController().signal));
  } finally {
    await f.close();
  }
});
void test('receipt files never follow symlinks or overwrite an unsafe target', async () => {
  const f = await fixture();
  try {
    const store = openReceiptStore(f.options);
    await store.put(f.envelope);
    const outside = join(f.root, 'synthetic-outside');
    await writeFile(outside, 'synthetic-protected', { mode: 0o600 });
    await rm(f.paths.state);
    await symlink(outside, f.paths.state);
    await assert.rejects(store.put(f.envelope));
    assert.equal(await readFile(outside, 'utf8'), 'synthetic-protected');
  } finally {
    await f.close();
  }
});

void test('receipt byte capacity evicts oldest metadata rather than locking out new records', async () => {
  const f = await fixture();
  try {
    const maxBytes = Buffer.byteLength(JSON.stringify(f.envelope)) * 2;
    const store = openReceiptStore({ ...f.options, maxEntries: 256, maxBytes });
    await store.put(f.envelope);
    f.advance(1);
    const seller = await signSellerReceipt(
      { ...f.record, requestId: '12'.repeat(16) },
      f.seller.sign,
    );
    await store.put({ seller });
    assert.ok(
      Buffer.byteLength(await readFile(f.paths.state, 'utf8')) <= maxBytes,
    );
    assert.equal(
      await store.load(f.key, new AbortController().signal),
      undefined,
    );
    assert.ok(
      await store.load(
        { ...f.key, executionRequestId: seller.record.requestId },
        new AbortController().signal,
      ),
    );
  } finally {
    await f.close();
  }
});
