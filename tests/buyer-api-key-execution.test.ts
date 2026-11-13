// Trusted buyer outcomes are attributed before delivery; all amounts and signers are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeApiKey,
  recordApiKeyPayment,
  reserveApiKey,
} from '@gyblos/buyer/api-key-execution';
import { createControlQuote } from '@gyblos/core/control-quotes';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { PAID_VERDICTS, SESSION_VERDICTS } from '@gyblos/node/constants';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

import { controlFixture } from './support/control-fixture';

async function fixture() {
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  const keys = await createBuyerApiKeys({
    files,
    scope: {
      network: 'synthetic',
      mint: '1'.repeat(32),
      payer: '2'.repeat(32),
    },
  });
  const key = await keys.create('Synthetic', '100');
  return { keys, key, files };
}
const quote = {
  maxAtomic: '100',
  requestId: 'synthetic',
  requestDigest: 'a'.repeat(64),
  sellerNodeId: 'b'.repeat(64),
};
const result = {
  text: 'synthetic',
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: ENGINE_DONE_REASONS.STOP,
};
void test('verified session approvals consume only the request amount, before a failed delivery', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      executeApiKey(
        f.keys,
        f.key.id,
        new AbortController().signal,
        async (_signal, operation) => {
          assert.ok(operation);
          await operation.reserve(quote);
          await recordApiKeyPayment(operation, {
            verdict: SESSION_VERDICTS.APPROVED,
            maxAtomic: '100',
            expectedAtomic: '30',
            chargedAtomic: null,
            sellerAtomic: null,
            feeAtomic: null,
            refundedAtomic: null,
            recorded: true,
            session: {
              approvedAtomic: '30',
              cumulativeAtomic: '900',
              depositAtomic: '1000',
            },
          });
          throw new Error('synthetic lost delivery');
        },
      ),
      /synthetic lost delivery/,
    );
    const key = (await f.keys.snapshot()).keys[0]!;
    assert.equal(key.spentAtomic, '30');
    assert.equal(key.approvedAtomic, '30');
    assert.equal(key.settledAtomic, '0');
    assert.equal(key.reservedAtomic, '0');
    f.keys.assertReady();
  } finally {
    await f.keys.close();
  }
});
void test('settled charges are durable before a caller aborts, and missing settlement retains the full ceiling', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const reply = await executeApiKey(
      f.keys,
      f.key.id,
      controller.signal,
      async (_signal, operation) => {
        assert.ok(operation);
        await operation.reserve(quote);
        const payment = {
          verdict: PAID_VERDICTS.SETTLED,
          maxAtomic: '100',
          expectedAtomic: '40',
          chargedAtomic: '40',
          sellerAtomic: '40',
          feeAtomic: '0',
          refundedAtomic: '60',
          recorded: true,
          transaction: '3'.repeat(88),
        };
        await recordApiKeyPayment(operation, payment);
        controller.abort();
        return { ...result, payment };
      },
    );
    assert.equal(reply.text, 'synthetic');
    assert.equal((await f.keys.snapshot()).keys[0]?.settledAtomic, '40');
    await assert.rejects(
      executeApiKey(
        f.keys,
        f.key.id,
        new AbortController().signal,
        async (_signal, operation) => {
          assert.ok(operation);
          await operation.reserve({ ...quote, maxAtomic: '60' });
          return result;
        },
      ),
      /BUYER_KEY_NEEDS_REVIEW/,
    );
    assert.equal((await f.keys.snapshot()).keys[0]?.reservedAtomic, '60');
    assert.equal((await f.keys.snapshot()).blocked, true);
  } finally {
    await f.keys.close();
  }
});
void test('a cancelled durable reservation never reaches inference or financial preparation', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const source = await controlFixture(false);
  const signed = await createControlQuote(
    {
      ...source.request,
      params: { ...source.request.params, maxAtomic: '100' },
    },
    source.context,
    source.ownerSigner,
  );
  const original = f.files.write;
  f.files.write = async (text) => {
    await original(text);
    controller.abort();
  };
  let dispatched = false;
  try {
    await assert.rejects(
      executeApiKey(
        f.keys,
        f.key.id,
        controller.signal,
        async (signal, operation) => {
          assert.ok(operation);
          await reserveApiKey(operation, signed, signal);
          dispatched = true;
          return result;
        },
      ),
    );
    assert.equal(dispatched, false);
    assert.equal((await f.keys.snapshot()).blocked, true);
  } finally {
    await f.keys.close();
  }
});
