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
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { DiagnosticSink } from '@gyblos/runtime/diagnostics';

import { controlFixture } from './support/control-fixture';

async function fixture(diagnostics?: DiagnosticSink) {
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  const keys = await createBuyerApiKeys({
    files,
    diagnostics,
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
          verdict: SESSION_VERDICTS.APPROVED,
          maxAtomic: '100',
          expectedAtomic: '40',
          chargedAtomic: null,
          sellerAtomic: null,
          feeAtomic: null,
          refundedAtomic: null,
          recorded: true,
          session: {
            approvedAtomic: '40',
            cumulativeAtomic: '40',
            depositAtomic: '100',
          },
        };
        await recordApiKeyPayment(operation, payment);
        controller.abort();
        return { ...result, payment };
      },
    );
    assert.equal(reply.text, 'synthetic');
    assert.equal((await f.keys.snapshot()).keys[0]?.approvedAtomic, '40');
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
async function paidQuote() {
  const source = await controlFixture(false);
  return createControlQuote(
    {
      ...source.request,
      params: { ...source.request.params, maxAtomic: '100' },
    },
    source.context,
    source.ownerSigner,
  );
}
void test('a cancelled durable reservation never reaches inference or financial preparation', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const signed = await paidQuote();
  const original = f.files.write;
  f.files.write = async (text) => {
    await original(text);
    controller.abort();
  };
  let preparations = 0;
  let dispatches = 0;
  try {
    await assert.rejects(
      executeApiKey(
        f.keys,
        f.key.id,
        controller.signal,
        async (signal, operation) => {
          assert.ok(operation);
          await reserveApiKey(operation, signed, signal);
          preparations++;
          dispatches++;
          return result;
        },
      ),
    );
    assert.equal(preparations, 0);
    assert.equal(dispatches, 0);
    const snapshot = await f.keys.snapshot();
    assert.equal(snapshot.blocked, false);
    assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
    assert.equal(snapshot.keys[0]?.spentAtomic, '0');
    await f.keys.close();
    const reopened = await createBuyerApiKeys({
      files: f.files,
      scope: snapshot.scope,
    });
    try {
      const next = await executeApiKey(
        reopened,
        f.key.id,
        new AbortController().signal,
        async (signal, operation) => {
          assert.ok(operation);
          assert.equal(operation.ceiling('100'), '100');
          await reserveApiKey(operation, signed, signal);
          return {
            ...result,
            payment: {
              verdict: SESSION_VERDICTS.APPROVED,
              maxAtomic: '100',
              expectedAtomic: '10',
              chargedAtomic: null,
              sellerAtomic: null,
              feeAtomic: null,
              refundedAtomic: null,
              recorded: true,
              session: {
                approvedAtomic: '10',
                cumulativeAtomic: '10',
                depositAtomic: '100',
              },
            },
          };
        },
      );
      assert.equal(next.text, result.text);
      const after = await reopened.snapshot();
      assert.equal(after.blocked, false);
      assert.equal(after.keys[0]?.spentAtomic, '10');
    } finally {
      await reopened.close();
    }
  } finally {
    await f.keys.close();
  }
});

void test('an unsent cancellation retains its primary error and durable reservation if release fails', async () => {
  const evidence: string[] = [];
  const f = await fixture((record) => {
    evidence.push(JSON.stringify(record));
    throw new Error('synthetic sink failure');
  });
  const signed = await paidQuote();
  const original = f.files.write;
  const controller = new AbortController();
  const reason = new Error('synthetic cancellation canary');
  let writes = 0;
  f.files.write = async (text) => {
    writes++;
    if (writes > 1) throw new Error('synthetic storage canary');
    await original(text);
    controller.abort(reason);
  };
  try {
    await assert.rejects(
      executeApiKey(
        f.keys,
        f.key.id,
        controller.signal,
        async (signal, operation) => {
          await reserveApiKey(operation, signed, signal);
          assert.fail('unexpected dispatch');
        },
      ),
      (error) => error === reason,
    );
    assert.equal(writes, 2);
    assert.equal(evidence.length, 1);
    assert.doesNotMatch(evidence[0]!, /canary/);
    const snapshot = await f.keys.snapshot();
    assert.equal(snapshot.blocked, true);
    await f.keys.close();
    const reopened = await createBuyerApiKeys({
      files: f.files,
      scope: snapshot.scope,
    });
    try {
      const restored = await reopened.snapshot();
      assert.equal(restored.blocked, true);
      assert.equal(restored.keys[0]?.reservedAtomic, '100');
    } finally {
      await reopened.close();
    }
  } finally {
    await f.keys.close();
  }
});
void test('revocation at the reservation boundary releases unsent authority without reactivating the key', async () => {
  const f = await fixture();
  const signed = await paidQuote();
  const op = f.keys.operation(f.key.id);
  const reserve = op.reserve;
  op.reserve = async (value) => {
    await reserve(value);
    await f.keys.revoke(f.key.id);
  };
  try {
    await assert.rejects(reserveApiKey(op, signed), { name: 'AbortError' });
    assert.equal(op.reserved(), false);
    assert.equal((await f.keys.snapshot()).keys[0]?.reservedAtomic, '0');
    assert.equal(f.keys.authenticate(f.key.secret), undefined);
  } finally {
    op.abandon();
    await f.keys.close();
  }
});
void test('an abort after dispatch retains the full reservation across restart', async () => {
  const f = await fixture();
  const signed = await paidQuote();
  const controller = new AbortController();
  let dispatches = 0;
  try {
    await assert.rejects(
      executeApiKey(f.keys, f.key.id, controller.signal, async (signal, op) => {
        await reserveApiKey(op, signed, signal);
        dispatches++;
        controller.abort();
        signal.throwIfAborted();
        return result;
      }),
      { name: 'AbortError' },
    );
    assert.equal(dispatches, 1);
    const { scope } = await f.keys.snapshot();
    await f.keys.close();
    const reopened = await createBuyerApiKeys({ files: f.files, scope });
    try {
      const snapshot = await reopened.snapshot();
      assert.equal(snapshot.blocked, true);
      assert.equal(snapshot.keys[0]?.reservedAtomic, '100');
    } finally {
      await reopened.close();
    }
  } finally {
    await f.keys.close();
  }
});
