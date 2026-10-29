// Fault-injects receipt client correlation and cancellation through typed SDK-independent ports.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFreeBuyerReceipt } from '@gyblos/core/receipts';
import {
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_CODES,
} from '@gyblos/protocol/constants';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import { signSellerReceipt } from '@gyblos/protocol/receipt';
import type { ReceiptChannelResponse } from '@gyblos/protocol/receipt-channel';
import {
  createReceiptTransport,
  type ReceiptConnection,
} from '@gyblos/transport-iroh/receipt-client';

import { receiptChannelFixture } from './support/receipt-channel';

async function fixture(
  patch: (
    value: ReceiptChannelResponse,
    source: Awaited<ReturnType<typeof receiptChannelFixture>>,
  ) => unknown = (value) => value,
) {
  const f = await receiptChannelFixture();
  let writes = 0;
  let closes = 0;
  let connects = 0;
  const remote = {
    id: () => ({ toString: () => f.seller.nodeId }),
    relayUrl: () => null,
  };
  const connection: ReceiptConnection = {
    remoteId: () => ({ toString: () => f.seller.nodeId }),
    closeReason: () => null,
    paths: () => [],
    close: () => {
      closes++;
    },
    async openBi() {
      const response = await patch(
        {
          version: RECEIPT_CHANNEL.version,
          requestId: f.get.requestId,
          result: { receipt: f.envelope },
        },
        f,
      );
      const frame = encodeControlFrame(response, RECEIPT_CHANNEL.frameBytes);
      let at = 0;
      return {
        recv: {
          async readExact(n) {
            const bytes = frame.slice(at, at + n);
            at += n;
            return [...bytes];
          },
          async read() {
            return [];
          },
        },
        send: {
          async writeAll() {
            writes++;
          },
          async finish() {},
        },
      };
    },
  };
  const endpoint = {
    id: () => ({ toString: () => f.buyer.nodeId }),
    async connect() {
      connects++;
      return connection;
    },
  };
  return {
    ...f,
    remote,
    connection,
    endpoint,
    writes: () => writes,
    closes: () => closes,
    connects: () => connects,
  };
}
void test('receipt client accepts verified historical seller and reuses only its receipt connection', async () => {
  const f = await fixture();
  const client = createReceiptTransport(f.endpoint, f.remote, f.seller.nodeId);
  try {
    await client.exchange(f.get);
    await client.exchange(f.get);
    assert.equal(f.connects(), 1);
    assert.equal(f.writes(), 2);
  } finally {
    await client.close();
  }
});
void test('receipt client rejects response correlation, execution and signature changes', async () => {
  for (const field of ['correlation', 'execution', 'signature']) {
    const run = await fixture(async (value, f) => {
      assert.ok(value.result);
      if (field === 'correlation')
        return { ...value, requestId: 'ff'.repeat(16) };
      const seller =
        field === 'signature'
          ? { ...f.envelope.seller, signature: '00'.repeat(64) }
          : await signSellerReceipt(
              { ...f.record, requestId: 'ff'.repeat(16) },
              f.seller.sign,
            );
      return { ...value, result: { receipt: { seller } } };
    });
    const client = createReceiptTransport(
      run.endpoint,
      run.remote,
      run.seller.nodeId,
    );
    try {
      await assert.rejects(client.exchange(run.get), {
        code:
          field === 'signature'
            ? RECEIPT_CHANNEL_CODES.SIGNATURE
            : RECEIPT_CHANNEL_CODES.BINDING,
      });
      assert.ok(run.closes() > 0);
    } finally {
      await client.close();
    }
  }
});

void test('receipt client rejects a different Iroh peer before any write', async () => {
  const f = await fixture();
  f.connection.remoteId = () => ({ toString: () => 'ff'.repeat(32) });
  const client = createReceiptTransport(f.endpoint, f.remote, f.seller.nodeId);
  try {
    await assert.rejects(client.exchange(f.get), {
      code: RECEIPT_CHANNEL_CODES.BINDING,
    });
    assert.equal(f.writes(), 0);
  } finally {
    await client.close();
  }
});
void test('receipt client preserves remote static error provenance', async () => {
  const f = await fixture(() => ({
    version: RECEIPT_CHANNEL.version,
    requestId: 'aa'.repeat(16),
    error: { code: RECEIPT_CHANNEL_CODES.NOT_FOUND },
  }));
  const client = createReceiptTransport(f.endpoint, f.remote, f.seller.nodeId);
  try {
    await assert.rejects(client.exchange(f.get), {
      code: RECEIPT_CHANNEL_CODES.NOT_FOUND,
      remote: true,
    });
  } finally {
    await client.close();
  }
});
void test('receipt client closes a native connection that resolves after cancellation and stays busy until it settles', async () => {
  const f = await fixture();
  let resolve: (value: ReceiptConnection) => void = () => {};
  const endpoint = {
    ...f.endpoint,
    connect: () =>
      new Promise<ReceiptConnection>((r) => {
        resolve = r;
      }),
  };
  const client = createReceiptTransport(endpoint, f.remote, f.seller.nodeId, {
    queryMs: 15,
  });
  await assert.rejects(client.exchange(f.get), {
    code: RECEIPT_CHANNEL_CODES.CANCELLED,
  });
  await assert.rejects(client.exchange(f.get), {
    code: RECEIPT_CHANNEL_CODES.BUSY,
  });
  resolve(f.connection);
  await client.settled();
  assert.equal(f.writes(), 0);
  assert.equal(f.closes(), 1);
  await client.close();
});
void test('receipt client applies pre-abort and configured relay policy before connect', async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  const client = createReceiptTransport(f.endpoint, f.remote, f.seller.nodeId);
  try {
    await assert.rejects(client.exchange(f.get, controller.signal), {
      code: RECEIPT_CHANNEL_CODES.CANCELLED,
    });
    assert.equal(f.connects(), 0);
  } finally {
    await client.close();
  }
  const relayed = { ...f.remote, relayUrl: () => 'https://synthetic.invalid' };
  const restricted = createReceiptTransport(
    f.endpoint,
    relayed,
    f.seller.nodeId,
  );
  try {
    await assert.rejects(restricted.exchange(f.get), {
      code: RECEIPT_CHANNEL_CODES.BINDING,
    });
    assert.equal(f.connects(), 0);
  } finally {
    await restricted.close();
  }
});

void test('receipt client rejects a validly signed confirmation different from the pair it submitted', async () => {
  const f = await fixture(async (value, source) => {
    const receipt = await createFreeBuyerReceipt(
      {
        seller: source.envelope.seller,
        context: source.context,
        observed: {
          ...source.confirm.params.receipt.buyer.record.observed,
          outputTokens: 6,
        },
      },
      source.buyer.sign,
    );
    return {
      ...value,
      requestId: source.confirm.requestId,
      result: { receipt },
    };
  });
  const client = createReceiptTransport(f.endpoint, f.remote, f.seller.nodeId);
  try {
    await assert.rejects(client.exchange(f.confirm), {
      code: RECEIPT_CHANNEL_CODES.BINDING,
    });
  } finally {
    await client.close();
  }
});
