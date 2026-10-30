// The buyer's durable journal on its own: one process at a time, strict reads (a valid document reads
// back, each malformed one is refused), the entry cap with pruning of old settled and expired unsigned
// entries, and no writes once closing. Temporary homes; no network.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buyerJournalPathsIn } from '@gyblos/config';
import { BUYER_JOURNAL, openUptoBuyerJournal } from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

const NOW = 1_800_000_000_000;
const DIGEST = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const unavailable = (error: unknown) =>
  error instanceof PaymentError &&
  error.code === PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE;

const ENTRY = {
  requestDigest: DIGEST,
  channelId: null,
  maxAtomic: '1000',
  expiresAt: NOW + 60_000,
  state: PAYMENT_CHANNEL_STATES.OPEN,
  chargedAtomic: null,
};

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-buyer-journal-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const open = (root: string, now = () => NOW, maxEntries?: number) =>
  openUptoBuyerJournal({
    paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
    now,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });

void test('one process holds the journal and stops writing once closing', () =>
  withRoot(async (root) => {
    const journal = await open(root);
    await assert.rejects(open(root), unavailable);
    const closing = journal.close();
    await assert.rejects(journal.put(ENTRY), unavailable);
    await closing;
    await (await open(root)).close();
    await assert.rejects(
      open(root, () => NOW, 0),
      unavailable,
    );
  }));

void test('a valid document reads back; each malformed one is refused', () =>
  withRoot(async (root) => {
    const { state } = buyerJournalPathsIn({ GYBLOS_HOME: root });
    const valid = { ...ENTRY, channelId: 'Chan1', updatedAt: NOW };
    const document = (entries: unknown[], extra = {}) =>
      JSON.stringify({ version: 1, entries, ...extra });
    // Written by hand, so the refusals below differ from it in exactly one way.
    await (await open(root)).close();
    await writeFile(state, document([valid]), { mode: 0o600 });
    const reader = await open(root);
    assert.deepEqual(await reader.list(), [valid]);
    await reader.close();
    for (const tampered of [
      JSON.stringify({ version: 2, entries: [valid] }),
      document([valid], { extra: 1 }),
      document([valid, valid]),
      document([{ ...valid, extra: 1 }]),
      document([{ ...valid, maxAtomic: '-1' }]),
      document([{ ...valid, maxAtomic: '1'.repeat(21) }]),
      document([{ ...valid, maxAtomic: '9'.repeat(20) }]),
      document([{ ...valid, state: 'lost' }]),
      document([{ ...valid, channelId: 'not a channel' }]),
      document([{ ...valid, expiresAt: '1' }]),
    ]) {
      await writeFile(state, tampered, { mode: 0o600 });
      const journal = await open(root);
      await assert.rejects(journal.list(), unavailable, tampered);
      await journal.close();
    }
  }));

void test('a full journal refuses new requests, keeps writing open ones and prunes finished ones', () =>
  withRoot(async (root) => {
    let now = NOW;
    const journal = await open(root, () => now, 1);
    await journal.put({ ...ENTRY, channelId: 'Chan1' });
    const other = { ...ENTRY, requestDigest: OTHER };
    await assert.rejects(journal.put(other), unavailable);
    // The open request still records its progress.
    await journal.put({
      ...ENTRY,
      channelId: 'Chan1',
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: '5',
    });
    // A signed entry is never removed; a settled one is pruned once retention passed.
    await assert.rejects(journal.remove(DIGEST), unavailable);
    now = NOW + BUYER_JOURNAL.settledRetentionMs;
    await journal.put({ ...other, expiresAt: now + 60_000 });
    assert.deepEqual(
      (await journal.list()).map((held) => held.requestDigest),
      [OTHER],
    );
    // An unsigned entry can be removed at once.
    await journal.remove(OTHER);
    assert.deepEqual(await journal.list(), []);
    await journal.close();
  }));
