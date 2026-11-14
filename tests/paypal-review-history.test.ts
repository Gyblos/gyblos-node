import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  paypalSandboxPaths,
  paypalSandboxReviewPaths,
} from '@gyblos/config/home';
import { parsePaypalResult } from '@gyblos/desktop/paypal-model';
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_REVIEW_ACTOR,
  PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
  PAYPAL_SESSION_REVIEW_DECISION,
} from '@gyblos/node/constants';
import { openPaypalJournal } from '@gyblos/node/paypal-journal';
import {
  createPaypalSession,
  type PaypalSessionRecord,
} from '@gyblos/node/paypal-session';
import { canonicalJson } from '@gyblos/protocol';
import {
  ensurePrivateDirectory,
  writePrivateFileOnce,
} from '@gyblos/runtime/private-file';

import { fixture } from './support/paypal-session-fixture';

void test('old reviewed terms remain verifiable before a new order can start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-terms-'));
  try {
    const journal = await openPaypalJournal(root);
    const session: PaypalSessionRecord = {
      version: 3,
      phase: PAYPAL_SESSION_PHASE.EXECUTING,
      requestId: 'REQUEST1',
      currency: 'USD',
      limitCents: 200,
      messageCents: 10,
      maxMessageAttempts: 40,
      spentCents: 150,
      attemptIds: [
        ...Array.from({ length: 15 }, (_, index) => `MESSAGE${index + 1}`),
        'AGENT1',
      ],
      acknowledgedIds: Array.from(
        { length: 15 },
        (_, index) => `MESSAGE${index + 1}`,
      ),
      agentCompletions: [],
      orderId: 'ORDER1',
      authorizationId: 'AUTH1',
      expiresAt: 12345678,
      messageId: 'AGENT1',
      promptDigest: 'a'.repeat(64),
    };
    const decision = {
      version: PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
      decision: PAYPAL_SESSION_REVIEW_DECISION.WAIVE_UNCERTAIN,
      actor: PAYPAL_SESSION_REVIEW_ACTOR.LOCAL_OPERATOR,
      decidedAt: 123456,
      verifiedAt: 123457,
      session,
    };
    const reviewDigest = createHash('sha256')
      .update(canonicalJson(decision))
      .digest('hex');
    const {
      messageId: _message,
      promptDigest: _prompt,
      ...remaining
    } = session;
    await journal.write({
      ...remaining,
      phase: PAYPAL_SESSION_PHASE.COMPLETED,
      captureId: 'CAPTURE1',
      reviewDigest,
    });
    const paths = paypalSandboxReviewPaths(root, session.requestId);
    await ensurePrivateDirectory(paypalSandboxPaths(root).reviewDirectory);
    await writePrivateFileOnce(paths.decision, JSON.stringify(decision), 9216);
    await writePrivateFileOnce(
      paths.outcome,
      JSON.stringify({
        version: PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
        decisionDigest: reviewDigest,
        amountCents: 150,
        captureId: 'CAPTURE1',
        completedAt: 123458,
      }),
      9216,
    );
    await journal.close();
    const reopened = await openPaypalJournal(root);
    const f = fixture();
    const next = await createPaypalSession({ ...f, journal: reopened });
    assert.equal(next.status().phase, PAYPAL_SESSION_PHASE.COMPLETED);
    assert.equal(next.status().limitCents, 200);
    assert.equal(next.status().spentCents, 150);
    assert.equal(next.status().remainingAttempts, 24);
    const { orderId: _orderId, ...status } = next.status();
    const parsed = parsePaypalResult({
      status: { ...status, approvalLinkAvailable: false },
      model: 'synthetic-model',
      answer: null,
      error: null,
    });
    assert.equal(parsed.status?.limitCents, 200);
    assert.equal(parsed.status?.spentCents, 150);
    await next.create();
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
