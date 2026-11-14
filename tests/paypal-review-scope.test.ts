import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_REVIEW_ACTOR,
  PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
  PAYPAL_SESSION_REVIEW_DECISION,
} from '@gyblos/node/constants';
import { openPaypalJournal } from '@gyblos/node/paypal-journal';
import type {
  PaypalReviewJournal,
  PaypalSessionRecord,
  PaypalWaiverArchive,
} from '@gyblos/node/paypal-session';

function sample(): {
  session: PaypalSessionRecord;
  archive: PaypalWaiverArchive;
} {
  const session: PaypalSessionRecord = {
    version: 3,
    phase: PAYPAL_SESSION_PHASE.EXECUTING,
    requestId: 'REQUEST1',
    currency: 'USD',
    limitCents: 100,
    messageCents: 10,
    maxMessageAttempts: 30,
    spentCents: 20,
    attemptIds: ['MESSAGE1', 'MESSAGE2', 'AGENT1'],
    acknowledgedIds: ['MESSAGE1', 'MESSAGE2'],
    agentCompletions: [],
    orderId: 'ORDER1',
    authorizationId: 'AUTH1',
    expiresAt: 12345678,
    messageId: 'AGENT1',
    promptDigest: 'a'.repeat(64),
  };
  return {
    session,
    archive: {
      version: PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
      decision: PAYPAL_SESSION_REVIEW_DECISION.WAIVE_UNCERTAIN,
      actor: PAYPAL_SESSION_REVIEW_ACTOR.LOCAL_OPERATOR,
      decidedAt: 123456,
      verifiedAt: 123457,
      session,
    },
  };
}

void test('a retained review scope cannot write after the review finishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-scope-'));
  try {
    const journal = await openPaypalJournal(root);
    const { session, archive } = sample();
    await journal.write(session);
    let retained: PaypalReviewJournal | undefined;
    let reviewDigest = '';
    await journal.review(async (scope) => {
      retained = scope;
      reviewDigest = await scope.archiveWaiver(archive);
    });
    assert.ok(retained);
    const {
      messageId: _message,
      promptDigest: _prompt,
      ...remaining
    } = session;
    await assert.rejects(
      retained.write({
        ...remaining,
        phase: PAYPAL_SESSION_PHASE.CAPTURING,
        reviewDigest,
      }),
    );
    assert.deepEqual(await journal.read(), session);
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a review does not release its lock until a started archival write settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-drain-'));
  try {
    const journal = await openPaypalJournal(root);
    const { session, archive } = sample();
    await journal.write(session);
    let settled = false;
    let started: Promise<unknown> = Promise.resolve();
    await journal.review(async (scope) => {
      started = scope.archiveWaiver(archive).then(() => {
        settled = true;
      });
    });
    assert.equal(settled, true);
    await started;
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
