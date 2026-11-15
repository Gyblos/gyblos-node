// The ordinary buyer must preserve the loaded tokenizer's block capability; homes and finance are synthetic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { batchSessionPathsIn } from '@gyblos/config/home';
import { OFFER_PRICING_KINDS, P2P_ROLES } from '@gyblos/protocol/constants';

import { blockTestMeter } from '../support/batch-block-product';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'ordinary buyer startup retains block verification supplied by its tokenizer',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, undefined, {
      meter: blockTestMeter,
      observe() {},
    });
    t.after(host.close);
    let questions = 0;
    let output = '';
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'synthetic' : '/exit'),
      write: (text) => {
        output += text;
      },
    });
    assert.match(output, /Approved this question/);
    assert.deepEqual(host.finance.calls, ['deposit']);
    assert.equal(host.engine.attempts(), 1);
    const record: unknown = JSON.parse(
      await readFile(
        batchSessionPathsIn(process.env, P2P_ROLES.BUYER).state,
        'utf8',
      ),
    );
    assert.ok(
      record && typeof record === 'object' && 'blocks' in record,
      'the real startup must select the block channel when its loaded meter supports it',
    );
  },
);
