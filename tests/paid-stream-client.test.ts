// Exercises the paid stream client over bounded SDK doubles: the paid ALPN, verified terminals
// returned with their charge and payment (refusals included), and the conservative sent state.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { paidExecutionDigest } from '@gyblos/protocol/paid-execution';
import { encodePaidStreamEvent } from '@gyblos/protocol/paid-stream';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from '@gyblos/protocol/paid/constants';
import { createPaidExecutionClient } from '@gyblos/transport-iroh/paid-client';

import { CHARGE, paidSource, RESULT, settled } from './support/paid-fixture';

interface Options {
  refused?: boolean;
  truncate?: boolean;
  trailing?: boolean;
  cancel?: AbortController;
  remoteId?: string;
}

async function fixture(options: Options = {}) {
  const source = await paidSource();
  const paid = source.paid;
  const header = {
    version: PAID_EXECUTION.version,
    requestId: paid.requestId,
    requestDigest: await paidExecutionDigest(paid),
  };
  const event = (sequence: number, fields: Record<string, unknown>) =>
    encodePaidStreamEvent({ ...header, sequence, ...fields });
  const frames = options.refused
    ? [
        event(0, {
          type: PAID_STREAM.events.TERMINAL,
          response: {
            ...header,
            error: { code: PAID_EXECUTION_CODES.PAYMENT_REJECTED },
          },
        }),
      ]
    : [
        event(0, { type: PAID_STREAM.events.DELTA, text: 'Hi' }),
        event(1, { type: PAID_STREAM.events.DELTA, text: '.' }),
        event(2, {
          type: PAID_STREAM.events.TERMINAL,
          response: {
            ...header,
            result: RESULT,
            charge: CHARGE,
            payment: settled(paid, CHARGE.chargedAtomic),
          },
        }),
      ];
  const all = Buffer.concat([
    ...frames,
    ...(options.trailing ? [Buffer.from([0])] : []),
  ]);
  const deltasEnd = options.refused ? 0 : frames[0]!.length + frames[1]!.length;
  let offset = 0;
  const counts = { dials: 0, writes: 0, closes: 0, alpn: '' };
  const deltas: string[] = [];
  const connection = {
    remoteId: () => ({ toString: () => source.trust.nodeId }),
    paths: () => [{ isSelected: true, isIp: true, isRelay: false }],
    close() {
      counts.closes++;
    },
    async openBi() {
      return {
        send: {
          async writeAll() {
            counts.writes++;
          },
          async finish() {},
        },
        recv: {
          async readExact(size: number) {
            if (options.truncate && offset >= deltasEnd) throw new Error('EOF');
            const value = all.subarray(offset, offset + size);
            offset += size;
            return [...value];
          },
          async read() {
            return [...all.subarray(offset)];
          },
        },
      };
    },
  } as unknown as Connection;
  const endpoint = {
    id: () => ({ toString: () => source.buyerNodeId }),
    async connect(_remote: EndpointAddr, protocol: number[]) {
      counts.dials++;
      counts.alpn = Buffer.from(protocol).toString();
      return connection;
    },
  } as unknown as Endpoint;
  const remote = {
    id: () => ({ toString: () => options.remoteId ?? source.trust.nodeId }),
    relayUrl: () => null,
  } as unknown as EndpointAddr;
  const client = createPaidExecutionClient(endpoint, remote, source.trust, {
    now: source.now,
    requestMs: 1000,
    async onDelta(text) {
      await Promise.resolve();
      deltas.push(text);
      options.cancel?.abort();
    },
  });
  return { client, paid, deltas, counts };
}

void test('the paid client dials the paid ALPN and returns the verified settled terminal', async () => {
  const value = await fixture();
  const terminal = await value.client.execute(value.paid);
  await value.client.settled();
  assert.deepEqual(terminal.result, RESULT);
  assert.deepEqual(terminal.charge, CHARGE);
  assert.equal(
    terminal.payment?.settlement?.channelId,
    value.paid.payment.channelId,
  );
  assert.deepEqual(value.deltas, ['Hi', '.']);
  assert.equal(value.counts.alpn, PAID_STREAM.alpn);
  assert.equal(value.counts.dials, 1);
  await assert.rejects(value.client.execute(value.paid), {
    code: PAID_EXECUTION_CODES.REPLAY,
  });
});

void test('a refusal terminal is returned, not thrown, so the caller sees no deposit', async () => {
  const value = await fixture({ refused: true });
  const terminal = await value.client.execute(value.paid);
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.PAYMENT_REJECTED);
  assert.equal(terminal.payment, undefined);
});

void test('a truncated stream or trailing bytes are errors with the request possibly sent', async () => {
  for (const options of [{ truncate: true }, { trailing: true }]) {
    const value = await fixture(options);
    await assert.rejects(value.client.execute(value.paid), { sent: true });
    await value.client.settled();
    assert.deepEqual(value.deltas, ['Hi', '.']);
  }
});

void test('cancelling after the first delta closes transport with the request sent', async () => {
  const controller = new AbortController();
  const value = await fixture({ cancel: controller });
  await assert.rejects(value.client.execute(value.paid, controller.signal), {
    code: PAID_EXECUTION_CODES.CANCELLED,
    sent: true,
  });
  await value.client.settled();
  assert.deepEqual(value.deltas, ['Hi']);
  assert.ok(value.counts.closes > 0);
});

void test('another seller is refused before dialing, with nothing sent', async () => {
  const value = await fixture({ remoteId: 'f'.repeat(64) });
  await assert.rejects(value.client.execute(value.paid), {
    code: PAID_EXECUTION_CODES.PEER,
    sent: false,
  });
  assert.equal(value.counts.dials, 0);
  assert.equal(value.counts.writes, 0);
});
