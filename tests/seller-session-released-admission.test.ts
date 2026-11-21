// A bound buyer whose opening was released (never funded, no channel) is bound again through the backend
// and asks for capacity before its next opening, so a slot freed for another buyer is never taken twice.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startSellerSessions } from '@gyblos/node/seller-sessions';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import {
  PaymentSessionError,
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';

void test('a released opening asks for capacity again before the same buyer reopens', async (t) => {
  const rig = await sessionRig({ depositAtomic: '10000' });
  t.after(rig.dispose);
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const session = rig.seller();
  let admissions = 0;
  let creations = 0;
  let capacity = true;
  const { service, close } = await startSellerSessions({
    buyerNodeId: rig.terms.buyerNodeId,
    owner: rig.terms.owner,
    nodeId: rig.terms.sellerNodeId,
    description: rig.terms,
    backend: {
      inspect: async () => undefined,
      create: async () => {
        creations++;
        return session;
      },
    },
    admit: async () => {
      admissions++;
      if (!capacity) throw new PaymentSessionError(SESSION_CODES.BUSY);
    },
    offers: () => [offers.live],
    now: rig.now,
  });
  t.after(close);
  const quote = await offers.quote(1);
  const open = () =>
    service.exchange(
      parseBatchChannelRequest({
        version: BATCH_CHANNEL.version,
        requestId: '12'.repeat(16),
        method: BATCH_METHODS.OPEN,
        params: { quote, terms: rig.terms, payload: '{}' },
      }),
      rig.terms.buyerNodeId,
      new AbortController().signal,
    );
  // The first opening fails before any deposit and is released: the session prepares again.
  t.mock.method(session, 'open', async () => {
    throw new PaymentSessionError(SESSION_CODES.UNAVAILABLE);
  });
  t.mock.method(session, 'snapshot', () => ({
    channelId: '',
    state: SESSION_STATES.OPENING,
    expiresAt: rig.terms.expiresAt,
    cumulativeAtomic: '0',
    reservedAtomic: '0',
  }));
  await assert.rejects(open(), { code: SESSION_CODES.UNAVAILABLE });
  const first = admissions;
  const created = creations;
  // Another buyer took the freed slot: the next opening is refused before reaching the session.
  capacity = false;
  let opened = 0;
  t.mock.method(session, 'open', async () => {
    opened++;
    return session.snapshot();
  });
  await assert.rejects(open(), { code: SESSION_CODES.BUSY });
  assert.equal(admissions, first + 1, 'capacity was asked again');
  assert.equal(creations, created, 'refused before binding the session again');
  assert.equal(opened, 0, 'the session never opened');
});
