// Real product startup, encrypted loopback and durable delegated authority; engine and finance are synthetic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PAID_BUYER } from '@gyblos/buyer/constants';
import { rolePathIn } from '@gyblos/config';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'native buyer keys constrain signed session quotes and retain approved usage across a product restart',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const host = await sessionProductHost();
    t.after(host.close);
    const token = (
      await readFile(
        rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.tokenFile),
        'utf8',
      )
    ).trim();
    const owner = (url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', 'Bearer ' + token);
      return request(url, { ...init, headers });
    };
    const metadata = await owner(
      new URL(BUYER_API.STATUS_PATH, host.buyer().url),
    );
    const policy = parseBuyerApiPolicy(await metadata.json());
    const created = await owner(
      new URL(BUYER_API_KEYS.PATH, host.buyer().url),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': '"' + policy.policyId + '"',
        },
        body: JSON.stringify({
          action: 'create',
          name: 'Synthetic tools',
          limitAtomic: '1000',
        }),
      },
    );
    assert.equal(created.status, 200, await created.clone().text());
    const key = parseBuyerApiKeysReply(await created.json()).created;
    assert.ok(key);
    const ask = () =>
      request(host.buyer().url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key.secret,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: policy.model,
          messages: [{ role: 'user', content: 'synthetic' }],
          max_tokens: 64,
        }),
      });
    const first = await ask();
    assert.equal(first.status, 200, await first.clone().text());
    const firstReply = await first.json();
    assert.equal(firstReply.gyblos_payment.maxAtomic, '1000');
    assert.equal(firstReply.gyblos_payment.chargedAtomic, null);
    const firstUsage = BigInt(firstReply.gyblos_payment.session.approvedAtomic);
    assert.ok(firstUsage > 0n);
    await host.restartBuyer();
    const second = await ask();
    assert.equal(second.status, 200, await second.clone().text());
    const secondReply = await second.json();
    assert.equal(
      secondReply.gyblos_payment.maxAtomic,
      String(1000n - firstUsage),
    );
    const status = await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url));
    const snapshot = parseBuyerApiKeysReply(await status.json()).snapshot;
    const spent =
      firstUsage + BigInt(secondReply.gyblos_payment.session.approvedAtomic);
    assert.equal(snapshot.keys[0]?.spentAtomic, String(spent));
    assert.equal(snapshot.keys[0]?.approvedAtomic, String(spent));
    assert.equal(snapshot.keys[0]?.settledAtomic, '0');
    assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
    assert.equal(snapshot.blocked, false);
    assert.deepEqual(host.finance.calls, ['deposit']);
  },
);
