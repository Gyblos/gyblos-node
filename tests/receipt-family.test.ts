// Receipt connections cannot occupy the inference family, while all endpoint global/rate caps remain shared.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { FREE_EXECUTION, RECEIPT_CHANNEL } from '@gyblos/protocol/constants';
import {
  connectionFamily,
  createConnectionAdmission,
} from '@gyblos/transport-iroh/admission';

void test('receipt connections have one bounded family distinct from inference with the same global pool', () => {
  const limits = {
    ...TRANSPORT_LIMITS,
    maxPeerConnections: 1,
    maxConnections: 2,
  };
  const admission = createConnectionAdmission(() => 0, limits);
  const peer = '11'.repeat(32);
  const data = admission.established(
    peer,
    connectionFamily(FREE_EXECUTION.alpn),
  );
  assert.ok(data);
  const receipt = admission.established(
    peer,
    connectionFamily(RECEIPT_CHANNEL.alpn),
  );
  assert.ok(receipt);
  assert.equal(
    admission.established(peer, connectionFamily(RECEIPT_CHANNEL.alpn)),
    undefined,
  );
  assert.equal(
    admission.established(
      '22'.repeat(32),
      connectionFamily(FREE_EXECUTION.alpn),
    ),
    undefined,
  );
  data();
  receipt();
});
