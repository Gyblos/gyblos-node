// Regresses clock-transition and signer-buffer ownership races with synthetic clocks and unfunded signers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { ControlAdmission } from '@gyblos/core/control-admission';
import { createControlQuote } from '@gyblos/core/control-quotes';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { signOfferV2, verifyOfferV2 } from '@gyblos/protocol/offer-v2';

import { controlFixture } from './support/control-fixture';

function advancingClock() {
  let value = 0;
  let advancing = false;
  return {
    read() {
      const current = value;
      if (advancing) value++;
      return current;
    },
    start(at: number) {
      value = at;
      advancing = true;
    },
    pause(at: number) {
      value = at;
      advancing = false;
    },
  };
}

void test('control publication uses one deadline snapshot when the clock advances between reads', () => {
  const clock = advancingClock();
  const admission = new ControlAdmission(clock.read);
  const connection = admission.openConnection('1'.repeat(64));
  const query = connection.beginQuery();
  clock.start(CONTROL_CAPACITY.queryMs - 1);
  assert.equal(query.publish('synthetic-result'), 'synthetic-result');
  // Idle expiry must follow the timestamp that admitted publication, not a second clock read.
  clock.pause(CONTROL_CAPACITY.queryMs - 1 + CONTROL_CAPACITY.connectionIdleMs);
  assert.throws(() => connection.check(), { code: CONTROL_CODES.CANCELLED });
  const expiredClock = advancingClock();
  const expiredAdmission = new ControlAdmission(expiredClock.read);
  const expired = expiredAdmission.openConnection('4'.repeat(64)).beginQuery();
  expiredClock.start(CONTROL_CAPACITY.queryMs);
  assert.throws(() => expired.publish('expired'), {
    code: CONTROL_CODES.CANCELLED,
  });
});

void test('control admission linearizes before idle expiry and never returns an already-cancelled lease', () => {
  const clock = advancingClock();
  const admission = new ControlAdmission(clock.read);
  const connection = admission.openConnection('2'.repeat(64));
  clock.start(CONTROL_CAPACITY.connectionIdleMs - 1);
  const query = connection.beginQuery();
  assert.doesNotThrow(() => query.check());
  query.finish();
  connection.close();
  clock.pause(0);
  const expiredAdmission = new ControlAdmission(clock.read);
  const expired = expiredAdmission.openConnection('3'.repeat(64));
  clock.start(CONTROL_CAPACITY.connectionIdleMs);
  assert.throws(() => expired.beginQuery(), { code: CONTROL_CODES.CANCELLED });
});

void test('control offer verifies and returns the same detached signature when the signer reuses its buffer', async (context) => {
  const fixture = await controlFixture();
  const original = await createControlQuote(
    fixture.request,
    fixture.context,
    fixture.ownerSigner,
  );
  let retained: Uint8Array | undefined;
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  context.mock.method(
    crypto.subtle,
    'verify',
    async (...args: Parameters<SubtleCrypto['verify']>) => {
      const result = verify(...args);
      retained?.fill(0);
      return result;
    },
  );
  const signed = await signOfferV2(original.offer, async (bytes) => {
    retained = Uint8Array.from(await fixture.ownerSigner(bytes));
    return retained;
  });
  assert.ok(
    retained?.every((byte) => byte === 0),
    'The signer-owned buffer must actually be reused.',
  );
  assert.equal(signed.signature, original.signature);
  assert.deepEqual(
    await verifyOfferV2(signed, fixture.trust()),
    original.offer,
  );
});
