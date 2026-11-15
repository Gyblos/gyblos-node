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

void test(
  'ordinary buyer restores an unacknowledged block before loading the tokenizer or accepting another prompt',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    let loads = 0;
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, undefined, {
      meter: blockTestMeter,
      loadMeter: async () => {
        loads++;
        return blockTestMeter;
      },
      observe() {},
    });
    t.after(host.close);
    host.finance.loseAcknowledgment();
    let questions = 0;
    let output = '';
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'synthetic' : '/exit'),
      write: (text) => {
        output += text;
      },
    });
    assert.match(output, /No retry was made/);
    assert.equal(host.engine.attempts(), 1);
    assert.equal(host.finance.approvals(), 1);
    assert.equal(loads, 1);
    await host.restartBoth();
    questions = 0;
    output = '';
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'new synthetic' : '/exit'),
      write: (text) => {
        output += text;
      },
    });
    assert.match(output, /Approved this question/);
    assert.equal(
      host.engine.attempts(),
      2,
      'the original prompt is never repeated',
    );
    assert.equal(
      host.finance.approvals(),
      2,
      'terminal ACK recovery reuses the seller acceptance instead of approving it twice',
    );
    assert.equal(loads, 2);
    assert.deepEqual(host.finance.calls, ['deposit']);
  },
);
