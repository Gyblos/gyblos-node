// Pins control runtime preflight ordering and the shared connection-open budget.
// Synthetic clocks/signers only; no engine, wallet files or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { createControlQuote } from '@gyblos/core/control-quotes';
import { CONTROL_CODES, REASONING_LEVELS } from '@gyblos/protocol/constants';
import { createConnectionAdmission } from '@gyblos/transport-iroh/admission';
import { CONNECTION_FAMILIES } from '@gyblos/transport-iroh/constants';

import { controlFixture } from './support/control-fixture';

void test('unsupported reasoning is refused before readiness or signing even when busy', async () => {
  const fixture = await controlFixture();
  fixture.request.params.reasoning = REASONING_LEVELS.HIGH;
  let reads = 0;
  await assert.rejects(
    createControlQuote(
      fixture.request,
      {
        ...fixture.context,
        readiness: () => {
          reads++;
          throw new Error('Unexpected readiness');
        },
      },
      async () => {
        throw new Error('Unexpected signer');
      },
    ),
    { code: CONTROL_CODES.LEVEL },
  );
  assert.equal(reads, 0);
});

void test('connection-open rate survives disconnects and source rotation and resets by window', () => {
  let now = 0;
  const admission = createConnectionAdmission(() => now);
  for (
    let index = 0;
    index < TRANSPORT_LIMITS.connectionAttemptsPerWindow;
    index++
  )
    assert.equal(admission.attempt(`source-${index}`), true);
  assert.equal(admission.attempt('new-source'), false);
  now = TRANSPORT_LIMITS.rateWindowMs;
  assert.equal(admission.attempt('new-source'), true);
});

void test('one connection source cannot consume the entire open-attempt window', () => {
  const admission = createConnectionAdmission();
  for (
    let index = 0;
    index < TRANSPORT_LIMITS.connectionAttemptsPerSource;
    index++
  )
    assert.equal(admission.attempt('one-source'), true);
  assert.equal(admission.attempt('one-source'), false);
  assert.equal(admission.attempt('another-source'), true);
});

void test('authenticated NodeId connection-open rate survives released connection leases', () => {
  const admission = createConnectionAdmission();
  for (
    let index = 0;
    index < TRANSPORT_LIMITS.connectionAttemptsPerPeer;
    index++
  ) {
    const release = admission.established('one-peer', CONNECTION_FAMILIES.DATA);
    assert.ok(release);
    release();
  }
  assert.equal(
    admission.established('one-peer', CONNECTION_FAMILIES.DATA),
    undefined,
  );
  assert.ok(admission.established('other-peer', CONNECTION_FAMILIES.DATA));
});
