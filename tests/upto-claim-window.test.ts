// Real SDK guards and native instruction construction on an in-memory RPC; never broadcasts or pays.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_ERROR_CODES,
  uptoClaimUntil,
  UptoError,
} from 'x402-upto-metered';

import { CLAIM_NOW, sdkClaimFixture } from './support/upto-claim';

void test('the opt-in Closing claim works through the SDK CommonJS entry too', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  const sdk = createRequire(import.meta.url)(
    '@x402/svm/upto/facilitator',
  ) as typeof import('@x402/svm/upto/facilitator');
  const rig = await sdkClaimFixture({
    allowClosingClaims: true,
    factory: (signer, _store) =>
      new sdk.UptoSvmScheme(signer, { allowClosingClaims: true }),
  });
  rig.fields.status = UPTO_CHANNEL_ACCOUNT.statuses.CLOSING;
  rig.fields.closureStartedAt = BigInt(CLAIM_NOW / 1000);
  assert.ok((await rig.chain.claim(rig.record, '10')).transaction);
  assert.equal(rig.sent.length, 1);
});

void test('a broadcast claim confirming after expiry is reconciled without a second transaction', async (context) => {
  let now = CLAIM_NOW;
  context.mock.method(Date, 'now', () => now);
  let confirms = 0;
  const rig = await sdkClaimFixture({
    allowClosingClaims: true,
    confirm: async () => {
      if (++confirms === 1) throw new Error('synthetic confirmation timeout');
    },
  });
  await assert.rejects(rig.chain.claim(rig.record, '10'), {
    code: UPTO_ERROR_CODES.UNAVAILABLE,
  });
  const signature = (await rig.store.getClaim(rig.record.channelId))
    ?.attempts?.[0];
  assert.ok(signature);
  now += 120000;
  rig.setNow(now);
  assert.deepEqual(await rig.chain.claim(rig.record, '10'), {
    transaction: signature,
  });
  assert.equal(confirms, 2);
  assert.equal(rig.sent.length, 1);
  await assert.rejects(rig.chain.claim(rig.record, '11'), {
    code: UPTO_ERROR_CODES.ALREADY_SETTLED,
  });
  assert.equal(rig.sent.length, 1);
});

void test('the actual SDK claim deadline is bounded milliseconds, independent of quote expiry', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  const rig = await sdkClaimFixture();
  assert.equal(uptoClaimUntil(rig.authorization), CLAIM_NOW + 120000);
  assert.notEqual(
    uptoClaimUntil(rig.authorization),
    rig.record.terms.expiresAt,
  );
  for (const expiresAt of [0, -1, Number.MAX_SAFE_INTEGER, '120', null]) {
    const payload: unknown = JSON.parse(
      Buffer.from(rig.authorization.payload, 'base64').toString(),
    );
    assert.ok(payload && typeof payload === 'object');
    const changed = {
      payload: Buffer.from(JSON.stringify({ ...payload, expiresAt })).toString(
        'base64',
      ),
    };
    assert.throws(() => uptoClaimUntil(changed), {
      code: UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH,
    });
  }
});

void test('an explicit upto claim can collect after payer closure during grace without changing the default', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  for (const allowClosingClaims of [false, true]) {
    const rig = await sdkClaimFixture({ allowClosingClaims });
    rig.fields.status = UPTO_CHANNEL_ACCOUNT.statuses.CLOSING;
    rig.fields.closureStartedAt = BigInt(CLAIM_NOW / 1000);
    const run = rig.chain.claim(rig.record, '10');
    if (!allowClosingClaims) {
      await assert.rejects(run, { code: UPTO_ERROR_CODES.UNAVAILABLE });
      assert.equal(rig.sent.length, 0);
    } else {
      assert.ok((await run).transaction);
      assert.equal(rig.sent.length, 1);
      assert.deepEqual(
        rig.sent[0]!.instructions.slice(-2).map((ix) => ix.data[0]),
        [4, 7],
      );
      await rig.chain.claim(rig.record, '10');
      assert.equal(rig.sent.length, 1);
    }
  }
});

void test('Closing claims stop exactly at grace expiry and retain all account bindings', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  for (const left of [1, 0, -1]) {
    const rig = await sdkClaimFixture({ allowClosingClaims: true });
    rig.fields.status = UPTO_CHANNEL_ACCOUNT.statuses.CLOSING;
    rig.fields.closureStartedAt = BigInt(
      CLAIM_NOW / 1000 - rig.fields.gracePeriod + left,
    );
    const run = rig.chain.claim(rig.record, '10');
    if (left > 0) assert.ok((await run).transaction);
    else await assert.rejects(run, UptoError);
    assert.equal(rig.sent.length, left > 0 ? 1 : 0);
  }
  for (const corrupt of [
    (fields: Awaited<ReturnType<typeof sdkClaimFixture>>['fields']) => {
      fields.deposit++;
    },
    (fields: Awaited<ReturnType<typeof sdkClaimFixture>>['fields']) => {
      fields.payer = fields.payee;
    },
    (fields: Awaited<ReturnType<typeof sdkClaimFixture>>['fields']) => {
      fields.payee = fields.payer;
    },
    (fields: Awaited<ReturnType<typeof sdkClaimFixture>>['fields']) => {
      fields.authorizedSigner = fields.payer;
    },
    (fields: Awaited<ReturnType<typeof sdkClaimFixture>>['fields']) => {
      fields.rentPayer = fields.payer;
    },
    (fields: Awaited<ReturnType<typeof sdkClaimFixture>>['fields']) => {
      fields.mint = fields.payer;
    },
    (fields: Awaited<ReturnType<typeof sdkClaimFixture>>['fields']) => {
      fields.gracePeriod++;
    },
    (fields: Awaited<ReturnType<typeof sdkClaimFixture>>['fields']) => {
      fields.distributionHash = new Uint8Array(32);
    },
  ]) {
    const hostile = await sdkClaimFixture({ allowClosingClaims: true });
    hostile.fields.status = UPTO_CHANNEL_ACCOUNT.statuses.CLOSING;
    hostile.fields.closureStartedAt = BigInt(CLAIM_NOW / 1000);
    corrupt(hostile.fields);
    await assert.rejects(hostile.chain.claim(hostile.record, '10'), UptoError);
    assert.equal(hostile.sent.length, 0);
  }
});

void test('SDK voucher expiry refuses a fresh claim at its exact boundary, never inventing a refund', async (context) => {
  let now = CLAIM_NOW;
  context.mock.method(Date, 'now', () => now);
  for (const elapsed of [119999, 120000]) {
    now = CLAIM_NOW;
    const rig = await sdkClaimFixture({ allowClosingClaims: true });
    now += elapsed;
    rig.setNow(now);
    const run = rig.chain.claim(rig.record, '10');
    if (elapsed < 120000) assert.ok((await run).transaction);
    else
      await assert.rejects(run, {
        code: UPTO_ERROR_CODES.FACILITATOR_REJECTED,
      });
    assert.equal(rig.sent.length, elapsed < 120000 ? 1 : 0);
  }
});
