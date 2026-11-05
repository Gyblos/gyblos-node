import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { paypalSandboxPaths } from '@gyblos/config/home';
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
  type PaypalWaiverArchive,
} from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('manual review privately preserves the uncertain session without overwriting an earlier archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-archive-'));
  try {
    const journal = await openPaypalJournal(root);
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
      expiresAt: Date.now() + 60000,
      messageId: 'AGENT1',
      promptDigest: 'a'.repeat(64),
    };
    const archive: PaypalWaiverArchive = {
      version: PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
      decision: PAYPAL_SESSION_REVIEW_DECISION.WAIVE_UNCERTAIN,
      actor: PAYPAL_SESSION_REVIEW_ACTOR.LOCAL_OPERATOR,
      decidedAt: 123456,
      verifiedAt: 123457,
      session,
    };
    await journal.write(session);
    await journal.review(async (review) => {
      const invalid = { ...archive, prompt: 'private-sentinel' };
      await assert.rejects(review.archiveWaiver(invalid));
      await review.archiveWaiver(archive);
      await assert.rejects(review.archiveWaiver(archive));
    });
    await assert.rejects(journal.review(async () => {}));
    const directory = paypalSandboxPaths(root).reviewDirectory;
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    assert.match(names[0]!, /^[a-f0-9]{64}-decision\.json$/);
    const file = join(directory, names[0]!);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), archive);
    await journal.close();
    const reopened = await openPaypalJournal(root);
    assert.deepEqual(await reopened.read(), session);
    await assert.rejects(reopened.review(async () => {}));
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a manual review excludes all other writes while its operation is in progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-lock-'));
  try {
    const journal = await openPaypalJournal(root);
    let continueReview: () => void = () => {};
    let reachedReview: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      reachedReview = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      continueReview = resolve;
    });
    const pending = journal.review(async () => {
      reachedReview();
      await paused;
    });
    await reached;
    await assert.rejects(
      journal.write({
        phase: 'capturing',
        requestId: 'REQUEST1',
        promptDigest: 'a'.repeat(64),
        maxTokens: 16,
        orderId: 'ORDER1',
        authorizationId: 'AUTH1',
      }),
    );
    continueReview();
    await pending;
    assert.equal(await journal.read(), null);
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('one real sandbox journal cannot back two session instances at the same time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-owner-'));
  try {
    const journal = await openPaypalJournal(root);
    const f = fixture();
    await createPaypalSession({ ...f, journal });
    await assert.rejects(createPaypalSession({ ...f, journal }));
    await journal.close();
    const reopened = await openPaypalJournal(root);
    await createPaypalSession({ ...f, journal: reopened });
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a settled review retains both its decision and capture after another session starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-complete-'));
  try {
    const journal = await openPaypalJournal(root);
    const f = fixture();
    const payment = {
      ...f.payment,
      async beginReview(
        _orderId: string,
        _requestId: string,
        authorizationId: string,
      ) {
        return {
          capture: (cents: number) => f.payment.capture(authorizationId, cents),
          release() {},
        };
      },
    };
    const session = await createPaypalSession({
      ...f,
      journal,
      payment,
      agentEngine: {
        model: 'synthetic-model',
        async generate() {
          throw new Error('synthetic uncertain inference');
        },
      },
    });
    const order = await session.create();
    await session.approve(order.orderId);
    for (const id of ['MESSAGE1', 'MESSAGE2']) {
      await session.message(order.orderId, 'synthetic', 16, id);
      await session.acknowledge(order.orderId, id);
    }
    await assert.rejects(
      session.agentMessage(
        order.orderId,
        {
          model: 'synthetic-model',
          messages: [{ role: 'user', content: 'synthetic' }],
          max_tokens: 16,
        },
        'AGENT1',
      ),
    );
    await session.settleReviewedInference(
      order.orderId,
      20,
      session.reviewTicket().fingerprint,
      Date.now(),
    );
    assert.equal(session.status().phase, PAYPAL_SESSION_PHASE.COMPLETED);
    const directory = paypalSandboxPaths(root).reviewDirectory;
    const before = (await readdir(directory)).sort();
    assert.equal(before.length, 2);
    assert.ok(before.some((name) => name.endsWith('-decision.json')));
    const outcomeName = before.find((name) => name.endsWith('-outcome.json'));
    assert.ok(outcomeName);
    const outcome = JSON.parse(
      await readFile(join(directory, outcomeName), 'utf8'),
    );
    assert.equal(outcome.amountCents, 20);
    assert.equal(outcome.captureId, 'CAPTURE1');
    await journal.close();
    const reopened = await openPaypalJournal(root);
    const next = await createPaypalSession({
      ...f,
      journal: reopened,
      payment,
    });
    await next.create();
    assert.deepEqual((await readdir(directory)).sort(), before);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a reviewed settlement with missing audit evidence cannot unlock a new order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-missing-'));
  try {
    const journal = await openPaypalJournal(root);
    const record: PaypalSessionRecord = {
      version: 3,
      phase: PAYPAL_SESSION_PHASE.COMPLETED,
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
      expiresAt: Date.now() + 60000,
      captureId: 'CAPTURE1',
      reviewDigest: 'a'.repeat(64),
    };
    await journal.write(record);
    await journal.close();
    const reopened = await openPaypalJournal(root);
    const f = fixture();
    const session = await createPaypalSession({ ...f, journal: reopened });
    assert.equal(session.status().phase, 'blocked');
    await assert.rejects(session.create());
    assert.deepEqual(f.calls, []);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
