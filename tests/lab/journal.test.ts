// Checks the lab gate journal guards: unresolved or uncertain authorizations block later paid
// attempts, reconciliation is terminal only for inference journals, and typed journals keep JSON.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RECONCILIATION_CLASSIFICATIONS } from '@gyblos/lab-harness/constants';
import {
  assertNoUnresolvedAuthorizations,
  saveJournal,
} from '@gyblos/lab-harness/journal';
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';

void test('an unresolved failure-case authorization blocks later paid attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-journal-'));
  const happy = join(directory, 'happy.json');
  const failure = join(directory, 'failure.json');
  try {
    await writeFile(happy, JSON.stringify({ state: 'verified' }));
    await writeFile(
      failure,
      JSON.stringify({
        state: 'authorization-created',
        channelId: 'uncertain',
      }),
    );
    await assert.rejects(
      assertNoUnresolvedAuthorizations([happy, failure] as Parameters<
        typeof assertNoUnresolvedAuthorizations
      >[0]),
      /Authorization may be unsettled/,
    );
    await writeFile(failure, JSON.stringify({ state: 'resolved-rejected' }));
    await assertNoUnresolvedAuthorizations([happy, failure] as Parameters<
      typeof assertNoUnresolvedAuthorizations
    >[0]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

void test('financial reconciliation is terminal only for inference journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-journal-'));
  try {
    for (const name of ['inference-attempt.json', 'attempt.json'])
      await writeFile(
        join(directory, name),
        JSON.stringify({ state: 'reconciled' }),
      );
    await assert.doesNotReject(
      assertNoUnresolvedAuthorizations([
        join(directory, 'inference-attempt.json'),
      ] as Parameters<typeof assertNoUnresolvedAuthorizations>[0]),
    );
    await assert.rejects(
      assertNoUnresolvedAuthorizations([
        join(directory, 'attempt.json'),
      ] as Parameters<typeof assertNoUnresolvedAuthorizations>[0]),
      /unsettled/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('typed journals preserve JSON serialization and path-specific terminal guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-typed-journals-'));
  try {
    const path = join(directory, 'exact-attempt.json');
    const record = {
      state: JOURNAL_STATES.CONFIRMED,
      transaction: 'public-signature',
      authorizationHash: 'public-hash',
      buyerSignature: 'public-buyer-signature',
      blockhash: undefined,
    };
    await saveJournal(path, record);
    assert.deepEqual(
      JSON.parse(await readFile(path, 'utf8')),
      JSON.parse(JSON.stringify(record)),
    );
    await assertNoUnresolvedAuthorizations([path] as Parameters<
      typeof assertNoUnresolvedAuthorizations
    >[0]);
    await saveJournal(path, {
      ...record,
      state: JOURNAL_STATES.UNCERTAIN,
      buyer: 'buyer',
      reconciliation: {
        classification: RECONCILIATION_CLASSIFICATIONS.UNAVAILABLE,
      },
    });
    await assert.rejects(
      assertNoUnresolvedAuthorizations([path] as Parameters<
        typeof assertNoUnresolvedAuthorizations
      >[0]),
      /Reconcile/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

void test('an uncertain exact journal blocks the shared authorization guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-exact-'));
  const path = join(directory, 'exact-attempt.json');
  try {
    await writeFile(path, JSON.stringify({ state: 'uncertain' }));
    await assert.rejects(
      assertNoUnresolvedAuthorizations([path] as Parameters<
        typeof assertNoUnresolvedAuthorizations
      >[0]),
      /Authorization may be unsettled/,
    );
    await writeFile(path, JSON.stringify({ state: 'confirmed' }));
    await assertNoUnresolvedAuthorizations([path] as Parameters<
      typeof assertNoUnresolvedAuthorizations
    >[0]);
  } finally {
    await rm(directory, { recursive: true });
  }
});
