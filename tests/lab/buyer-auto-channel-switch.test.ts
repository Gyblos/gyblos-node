import assert from 'node:assert/strict';
import { test } from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { httpMultisellerHost } from '../support/http-multiseller-host';
import {
  httpMultiAnswer,
  httpMultiChat,
} from '../support/http-multiseller-http';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { buyerClient } from '../support/session-product-client';

void test(
  'delegated paid Auto preserves the current channel while owner Auto switches to the sole available seller',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const host = await httpMultisellerHost(undefined, null);
    t.after(host.close);
    const a = host.sellers[0]!;
    const b = host.sellers[1]!;
    let listed = a.role.nodeId;
    const list = host.index.storage.list.bind(host.index.storage);
    host.index.storage.list = async (query) =>
      (await list(query)).filter((row) => row.nodeId === listed);
    const { ask } = await buyerClient(host, request, '100000');
    httpMultiAnswer(await httpMultiChat(host), 0);
    const read = () =>
      inspectBatchSession(batchSessionPathsIn(process.env, P2P_ROLES.BUYER));
    const original = await read();
    assert.ok(original?.snapshot.channelId);
    const before = [...host.ledger.calls];
    listed = b.role.nodeId;
    const refused = await ask(64);
    const reply = await refused.json();
    assert.equal(reply.error?.code, SESSION_CODES.REPLACEMENT_REQUIRED);
    assert.equal(reply.error[BUYER_API.NEVER_SENT_FIELD], true);
    assert.deepEqual((await read())?.snapshot, original.snapshot);
    assert.deepEqual(host.ledger.calls, before);
    assert.equal((await b.health()).generations, 0);
    const switched = await httpMultiChat(host);
    assert.equal(switched.response.status, 200);
    httpMultiAnswer(switched, 1);
    assert.deepEqual(
      host.ledger.calls.map((call) => [call.seller, call.type]),
      [
        [a.role.nodeId, 'deposit'],
        [a.role.nodeId, 'refund'],
        [b.role.nodeId, 'deposit'],
      ],
    );
    assert.ok(host.ledger.settled.has(original.snapshot.channelId));
    assert.equal((await read())?.terms.sellerNodeId, b.role.nodeId);
  },
);
