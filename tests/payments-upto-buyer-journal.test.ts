// The buyer's durable journal on its own: one process at a time, strict reads (a valid document reads
// back, each malformed one is refused), older versions read with what they lacked, the entry cap with pruning of old settled and expired unsigned
// entries, and no writes once closing. Temporary homes; no network.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buyerJournalPathsIn } from '@gyblos/config';
import { BUYER_JOURNAL, openUptoBuyerJournal } from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
  PUBLIC_RECORD_LIMITS,
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
  // Any two well-formed addresses.
  payTo: '11111111111111111111111111111111',
  feePayer: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  maxAtomic: '1000',
  policy: {
    mint: 'So11111111111111111111111111111111111111112',
    treasury: 'SysvarRent111111111111111111111111111111111',
    protocolFeeBps: 300,
  },
  openSlot: '1',
  lastValidBlockHeight: '100',
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
      JSON.stringify({ version: BUYER_JOURNAL.version, entries, ...extra });
    // Written by hand, so the refusals below differ from it in exactly one way.
    await (await open(root)).close();
    await writeFile(state, document([valid]), { mode: 0o600 });
    const reader = await open(root);
    assert.deepEqual(await reader.list(), [valid]);
    await reader.close();
    for (const tampered of [
      // Another version, including the ones before the open's policy, slot and blockhash lifetime.
      JSON.stringify({ version: BUYER_JOURNAL.version + 1, entries: [valid] }),
      JSON.stringify({ version: 2, entries: [valid] }),
      JSON.stringify({ version: 1, entries: [valid] }),
      JSON.stringify({ version: '3', entries: [valid] }),
      document([{ ...valid, lastValidBlockHeight: '-1' }]),
      document([valid], { extra: 1 }),
      document([valid, valid]),
      document([{ ...valid, extra: 1 }]),
      document([{ ...valid, maxAtomic: '-1' }]),
      document([{ ...valid, maxAtomic: '1'.repeat(21) }]),
      document([{ ...valid, maxAtomic: '9'.repeat(20) }]),
      document([{ ...valid, state: 'lost' }]),
      document([{ ...valid, channelId: 'not a channel' }]),
      document([{ ...valid, payTo: 'not an address' }]),
      document([{ ...valid, policy: { ...valid.policy, mint: 'not a mint' } }]),
      document([{ ...valid, policy: { ...valid.policy, treasury: 1 } }]),
      document([{ ...valid, policy: { ...valid.policy, protocolFeeBps: -1 } }]),
      document([
        { ...valid, policy: { ...valid.policy, protocolFeeBps: 1_001 } },
      ]),
      document([
        { ...valid, policy: { ...valid.policy, protocolFeeBps: 1.5 } },
      ]),
      document([{ ...valid, policy: { ...valid.policy, extra: 1 } }]),
      document([{ ...valid, policy: { mint: valid.policy.mint } }]),
      document([{ ...valid, policy: 'none' }]),
      document([{ ...valid, expiresAt: '1' }]),
    ]) {
      await writeFile(state, tampered, { mode: 0o600 });
      const journal = await open(root);
      await assert.rejects(journal.list(), unavailable, tampered);
      await journal.close();
    }
  }));

void test('a version 2 journal reads without a policy and is saved as the current version', () =>
  withRoot(async (root) => {
    const { state } = buyerJournalPathsIn({ GYBLOS_HOME: root });
    const { policy: _policy, ...v2 } = {
      ...ENTRY,
      channelId: 'Chan1',
      updatedAt: NOW,
    };
    await (await open(root)).close();
    await writeFile(state, JSON.stringify({ version: 2, entries: [v2] }), {
      mode: 0o600,
    });
    const journal = await open(root);
    assert.deepEqual(await journal.list(), [{ ...v2, policy: null }]);
    await journal.put({ ...ENTRY, requestDigest: OTHER });
    await journal.close();
    const saved = JSON.parse(await readFile(state, 'utf8')) as {
      version: number;
      entries: { policy: unknown }[];
    };
    assert.equal(saved.version, BUYER_JOURNAL.version);
    assert.deepEqual(
      saved.entries.map((held) => held.policy),
      [null, ENTRY.policy],
    );
  }));

void test('a version 1 journal keeps its signed opens, never proven unopened, and drops unsigned ones', () =>
  withRoot(async (root) => {
    const { state } = buyerJournalPathsIn({ GYBLOS_HOME: root });
    const {
      openSlot: _openSlot,
      lastValidBlockHeight: _height,
      policy: _policy,
      ...v1
    } = { ...ENTRY, updatedAt: NOW };
    await (await open(root)).close();
    await writeFile(
      state,
      JSON.stringify({
        version: 1,
        entries: [
          { ...v1, channelId: 'Chan1' },
          { ...v1, requestDigest: OTHER },
        ],
      }),
      { mode: 0o600 },
    );
    const journal = await open(root);
    assert.deepEqual(await journal.list(), [
      {
        ...v1,
        channelId: 'Chan1',
        openSlot: '0',
        lastValidBlockHeight: String(BigInt(PUBLIC_RECORD_LIMITS.maxAtomic)),
        policy: null,
      },
    ]);
    // The next write saves it as the current version, which the strict parser reads back.
    await journal.put({ ...ENTRY, requestDigest: OTHER });
    await journal.close();
    assert.equal(
      (JSON.parse(await readFile(state, 'utf8')) as { version: number })
        .version,
      BUYER_JOURNAL.version,
    );
    const reread = await open(root);
    assert.equal((await reread.list()).length, 2);
    await reread.close();
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
    // Nor by naming its channel once it settled: only an open the buyer never sent can go.
    await assert.rejects(journal.remove(DIGEST, 'Chan1'), unavailable);
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

void test('a full journal of the widest entries still fits its byte bound', () =>
  withRoot(async (root) => {
    const { state } = buyerJournalPathsIn({ GYBLOS_HOME: root });
    // A 44-character address, the longest form.
    const address = 'ATokenGPvbdGVxr1b2hvZbsiqW5xUH25efTNsLJA8knL';
    const atomic = '1'.repeat(20);
    const widest = (index: number) => ({
      requestDigest: index.toString(16).padStart(64, '0'),
      channelId: 'C'.repeat(128),
      payTo: address,
      feePayer: address,
      maxAtomic: atomic,
      policy: { mint: address, treasury: address, protocolFeeBps: 1_000 },
      openSlot: atomic,
      lastValidBlockHeight: atomic,
      expiresAt: Number.MAX_SAFE_INTEGER,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: atomic,
      updatedAt: Number.MAX_SAFE_INTEGER,
    });
    const entries = Array.from({ length: BUYER_JOURNAL.maxEntries }, (_, i) =>
      widest(i),
    );
    await (await open(root)).close();
    await writeFile(
      state,
      JSON.stringify({ version: BUYER_JOURNAL.version, entries }),
      { mode: 0o600 },
    );
    const journal = await open(root);
    assert.equal((await journal.list()).length, BUYER_JOURNAL.maxEntries);
    // Rewriting one entry, stamped with a wider time than any it held, still fits.
    const { updatedAt: _updatedAt, ...first } = widest(0);
    await journal.put(first);
    await journal.close();
  }));
