import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { paypalSandboxPaths } from '@gyblos/config/home';
import { openPaypalJournal } from '@gyblos/node/paypal-journal';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { canonicalJson } from '@gyblos/protocol';

import { fixture } from './support/paypal-session-fixture';

const previous = {
  version: 3,
  phase: 'voiding',
  requestId: 'REQUEST1',
  currency: 'USD',
  limitCents: 100,
  messageCents: 10,
  maxMessageAttempts: 30,
  spentCents: 0,
  attemptIds: [],
  acknowledgedIds: [],
  agentCompletions: [],
  orderId: 'ORDER1',
  authorizationId: 'AUTH1',
  expiresAt: 2000000000000,
};
const archive = {
  version: 1,
  decision: 'sandbox-exception-accept-unknown-history',
  decisionSource: 'founder-chat',
  decisionScope: 'single-sandbox-authorization',
  history: 'unknown',
  externalOperations: 'unknown',
  recordedUsageCents: 0,
  providerAuthorization: 'VOIDED',
  historyEvidence: {
    source: 'paypal-transaction-search',
    windowStart: '2026-11-01T23:33:32.000Z',
    windowEnd: '2026-11-05T22:55:37.039Z',
    lastRefreshed: '2026-11-05T20:59:59Z',
    pages: 1,
    balanceAffectingOnly: false,
    events: [
      {
        code: 'T1302',
        status: 'V',
        isAuthorization: true,
        referencesAuthorization: false,
        isObservedMovement: false,
        amount: '1.00',
        currency: 'USD',
      },
    ],
  },
  recordedAt: 123456,
  previous,
};
const digest = createHash('sha256')
  .update(canonicalJson(archive))
  .digest('hex');
const marker = createHash('sha256').update(previous.requestId).digest('hex');

void test('a void exception can reopen only while its exact audit evidence exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-void-exception-'));
  try {
    const paths = paypalSandboxPaths(root);
    await mkdir(paths.reviewDirectory, { mode: 0o700 });
    await writeFile(
      join(paths.reviewDirectory, `${marker}-void-sandbox-exception.json`),
      JSON.stringify(archive),
      { mode: 0o600 },
    );
    await writeFile(
      paths.state,
      JSON.stringify({
        ...previous,
        phase: 'voided',
        voidReviewDigest: digest,
      }),
      { mode: 0o600 },
    );
    const journal = await openPaypalJournal(root);
    const session = await createPaypalSession({ ...fixture(), journal });
    assert.equal(session.status().phase, 'voided');
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a void exception with missing or changed evidence stays blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-void-exception-missing-'));
  try {
    const paths = paypalSandboxPaths(root);
    await writeFile(
      paths.state,
      JSON.stringify({
        ...previous,
        phase: 'voided',
        voidReviewDigest: digest,
      }),
      { mode: 0o600 },
    );
    const journal = await openPaypalJournal(root);
    const session = await createPaypalSession({ ...fixture(), journal });
    assert.equal(session.status().phase, 'blocked');
    await assert.rejects(session.create());
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('an unfinished exception remains blocked if archival succeeds before state changes', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'paypal-void-exception-interrupted-'),
  );
  try {
    const paths = paypalSandboxPaths(root);
    await mkdir(paths.reviewDirectory, { mode: 0o700 });
    await writeFile(
      join(paths.reviewDirectory, `${marker}-void-sandbox-exception.json`),
      JSON.stringify(archive),
      { mode: 0o600 },
    );
    await writeFile(paths.state, JSON.stringify(previous), { mode: 0o600 });
    const journal = await openPaypalJournal(root);
    const session = await createPaypalSession({ ...fixture(), journal });
    assert.equal(session.status().phase, 'blocked');
    await assert.rejects(session.create());
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a void exception with modified evidence stays blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-void-exception-altered-'));
  try {
    const paths = paypalSandboxPaths(root);
    await mkdir(paths.reviewDirectory, { mode: 0o700 });
    await writeFile(
      join(paths.reviewDirectory, `${marker}-void-sandbox-exception.json`),
      JSON.stringify({ ...archive, history: 'none' }),
      { mode: 0o600 },
    );
    await writeFile(
      paths.state,
      JSON.stringify({
        ...previous,
        phase: 'voided',
        voidReviewDigest: digest,
      }),
      { mode: 0o600 },
    );
    const journal = await openPaypalJournal(root);
    const session = await createPaypalSession({ ...fixture(), journal });
    assert.equal(session.status().phase, 'blocked');
    await assert.rejects(session.create());
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a recovered historical exception remains sealed when sandbox terms change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-void-exception-terms-'));
  try {
    const paths = paypalSandboxPaths(root);
    await writeFile(
      paths.state,
      JSON.stringify({
        ...previous,
        phase: 'voided',
        limitCents: previous.limitCents + 100,
        voidReviewDigest: digest,
      }),
      { mode: 0o600 },
    );
    const journal = await openPaypalJournal(root);
    const session = await createPaypalSession({ ...fixture(), journal });
    assert.equal(session.status().phase, 'blocked');
    await assert.rejects(session.create());
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
