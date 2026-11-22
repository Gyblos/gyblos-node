// A declared quote is checked by bytes, never by the pinned Qwen tokenizer: preflight accepts it when the
// tokenizer cannot load, while a recounted quote still needs it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionPreflight } from '@gyblos/buyer/session-requirements';
import { CONTROL_METERING_MODES } from '@gyblos/protocol/constants';

import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';

const POLICY = {
  depositAtomic: '1000000',
  lifetimeMs: 3600000,
  withdrawDelaySeconds: 900,
};

void test('declared preflight never loads the tokenizer; recounted preflight still requires it', async (t) => {
  const rig = await sessionRig();
  t.after(() => rig.dispose());
  const fixture = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const declared = await fixture.quote(1, {
    meteringMode: CONTROL_METERING_MODES.DECLARED,
  });
  t.mock.method(Date, 'now', () => declared.offer.issuedAt);
  const recounted = await fixture.quote(2);
  let loads = 0;
  const preflight = createSessionPreflight(
    async () => {
      loads += 1;
      throw new Error('the pinned tokenizer is not installed');
    },
    POLICY,
    () => declared.offer.buyerNodeId,
  );
  const signal = new AbortController().signal;
  await preflight(declared, fixture.input, signal);
  assert.equal(loads, 0);
  await assert.rejects(preflight(recounted, fixture.input, signal));
  assert.equal(loads, 1);
});
