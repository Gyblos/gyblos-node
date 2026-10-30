// The durable upto ledger file: survives restarts, stays private, refuses tampering, serializes
// writers, belongs to one live process at a time and prunes only finished channels and stale
// pending signatures. Temporary directories only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createUptoSeller,
  UPTO_CHANNEL_STATES,
  UPTO_DEPOSIT_STATES,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoChain,
  type UptoChannelRecord,
} from 'x402-upto-metered';

import { paymentPathsIn } from '@gyblos/config';
import { LEDGER_FILE, openUptoFileLedger } from '@gyblos/payments-upto';

const NOW = 1_800_000_000_000;
const RETENTION_MS = LEDGER_FILE.minRetentionMs;

async function directory() {
  return mkdtemp(join(tmpdir(), 'gyblos-upto-ledger-'));
}

function paths(root: string) {
  return paymentPathsIn({ GYBLOS_HOME: root }, 'seller');
}

function record(
  channelId: string,
  state: UptoChannelRecord['state'] = UPTO_CHANNEL_STATES.ADMITTED,
): UptoChannelRecord {
  return {
    channelId,
    payer: 'Payer1111111111111111111111111111111111111',
    maxAtomic: '1030000',
    state,
    payload: Buffer.from('{}').toString('base64'),
    terms: {
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: 'Mint111111111111111111111111111111111111111',
      payTo: 'PayTo11111111111111111111111111111111111111',
      feePayer: 'Fee11111111111111111111111111111111111111111',
      authorizer: 'Auth1111111111111111111111111111111111111111',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      maxAtomic: '1030000',
      expiresAt: NOW + 60_000,
      memo: `gyblos:${'ab'.repeat(32)}`,
      withdrawDelaySeconds: 60,
      maxTimeoutSeconds: 120,
      splits: [
        { recipient: 'PayTo11111111111111111111111111111111111111', bps: 9709 },
        { recipient: 'Treasury11111111111111111111111111111111111', bps: 291 },
      ],
      reference: 'cd'.repeat(32),
    },
  };
}

const unavailable = (error: unknown) =>
  error instanceof UptoError &&
  error.code === UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE;

async function ledger(
  root: string,
  options: { now?: () => number; retentionMs?: number } = {},
) {
  return openUptoFileLedger({
    paths: paths(root),
    now: options.now ?? (() => NOW),
    retentionMs: options.retentionMs ?? RETENTION_MS,
    maxChannels: 3,
  });
}

// Opens the ledger, runs one step against it and closes it, as one process lifetime.
async function session<T>(
  root: string,
  run: (store: Awaited<ReturnType<typeof ledger>>) => Promise<T>,
): Promise<T> {
  const store = await ledger(root);
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}

void test('channel and chain records survive a restart, in private files', async () => {
  const root = await directory();
  try {
    await session(root, async (first) => {
      await first.channels.put(record('Chan1'));
      await first.chain.putDeposit({ channelId: 'Chan1', sentAt: NOW });
      await first.chain.putClaim({ channelId: 'Chan1', chargedAtomic: '5' });
      await first.chain.putPending('upto:x:Chan1', 'sig');
    });
    const second = await ledger(root);
    assert.deepEqual(await second.channels.get('Chan1'), record('Chan1'));
    assert.deepEqual(await second.channels.list(), [record('Chan1')]);
    assert.deepEqual(await second.chain.getDeposit('Chan1'), {
      channelId: 'Chan1',
      sentAt: NOW,
    });
    assert.deepEqual(await second.chain.getClaim('Chan1'), {
      channelId: 'Chan1',
      chargedAtomic: '5',
    });
    assert.equal(await second.chain.getPending('upto:x:Chan1'), 'sig');
    await second.chain.deletePending('upto:x:Chan1');
    await second.close();
    assert.equal(
      await session(root, (third) => third.chain.getPending('upto:x:Chan1')),
      undefined,
    );
    const { directory: dir, state } = paths(root);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(state)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(state, 'utf8'), /key|secret/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('concurrent writers in one process never lose an update', async () => {
  const root = await directory();
  try {
    await session(root, (store) =>
      Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.chain.putPending(`key-${index}`, `sig-${index}`),
        ),
      ),
    );
    await session(root, async (reopened) => {
      for (let index = 0; index < 20; index++)
        assert.equal(
          await reopened.chain.getPending(`key-${index}`),
          `sig-${index}`,
        );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a tampered, linked or malformed ledger is refused, never repaired', async () => {
  const root = await directory();
  try {
    await session(root, (store) => store.channels.put(record('Chan1')));
    const { state } = paths(root);
    const document = (extra: object) =>
      JSON.stringify({
        version: 1,
        channels: {},
        deposits: {},
        claims: {},
        pending: {},
        ...extra,
      });
    for (const text of [
      'not json',
      JSON.stringify({
        version: 2,
        channels: {},
        deposits: {},
        claims: {},
        pending: {},
      }),
      JSON.stringify({
        version: 1,
        channels: {
          Chan1: {
            record: { ...record('Chan1'), state: 'refunded' },
            updatedAt: NOW,
          },
        },
        deposits: {},
        claims: {},
        pending: {},
      }),
      JSON.stringify({
        version: 1,
        channels: { Chan1: { record: { channelId: 1 }, updatedAt: NOW } },
        deposits: {},
        claims: {},
        pending: {},
      }),
      // An unknown field anywhere is refused rather than silently dropped.
      document({ extra: true }),
      document({
        channels: {
          Chan1: { record: { ...record('Chan1'), extra: 1 }, updatedAt: NOW },
        },
      }),
      // A pending entry without its stored time (the earlier shape).
      document({ pending: { key: 'sig' } }),
    ]) {
      await writeFile(state, text, { mode: 0o600 });
      await assert.rejects(
        session(root, (store) => store.channels.list()),
        unavailable,
      );
    }
    await rm(state);
    const elsewhere = join(root, 'elsewhere.json');
    // A valid ledger elsewhere: only the refusal to follow the link keeps it out.
    await writeFile(
      elsewhere,
      JSON.stringify({
        version: 1,
        channels: {},
        deposits: {},
        claims: {},
        pending: {},
      }),
      { mode: 0o600 },
    );
    await symlink(elsewhere, state);
    await assert.rejects(
      session(root, (store) => store.channels.list()),
      unavailable,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('the ledger belongs to one live process; a dead owner on this host is taken over', async () => {
  const root = await directory();
  try {
    const store = await ledger(root);
    // A second opener, in this or another live process, is refused while the first holds it.
    await assert.rejects(ledger(root), unavailable);
    await store.channels.put(record('Chan1'));
    await store.close();
    await assert.rejects(store.channels.put(record('Chan2')), unavailable);
    const { lock } = paths(root);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(lock, JSON.stringify({ pid: dead, host: hostname() }), {
      mode: 0o600,
    });
    await session(root, (next) => next.channels.put(record('Chan2')));
    await writeFile(lock, JSON.stringify({ pid: dead, host: 'another-host' }), {
      mode: 0o600,
    });
    await assert.rejects(ledger(root), unavailable);
    await rm(lock);
    assert.equal(
      (await session(root, (next) => next.channels.list())).length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a lock lost while open stops writes instead of overwriting', async () => {
  const root = await directory();
  try {
    const store = await ledger(root);
    await store.channels.put(record('Chan1'));
    const { lock } = paths(root);
    await rm(lock);
    await writeFile(lock, 'someone else', { mode: 0o600 });
    await assert.rejects(store.channels.put(record('Chan2')), unavailable);
    await assert.rejects(store.close(), unavailable);
    assert.equal(await readFile(lock, 'utf8'), 'someone else');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('retention shorter than the minimum is refused', async () => {
  const root = await directory();
  try {
    for (const retentionMs of [0, RETENTION_MS - 1, 1.5])
      await assert.rejects(ledger(root, { retentionMs }), unavailable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('finished channels are pruned after retention; active ones are never dropped', async () => {
  const root = await directory();
  let now = NOW;
  try {
    const store = await ledger(root, { now: () => now });
    await store.channels.put(record('Done', UPTO_CHANNEL_STATES.SETTLED));
    await store.channels.put(record('Gone', UPTO_CHANNEL_STATES.FAILED));
    await store.channels.put(record('Open1'));
    await store.chain.putPending('upto:x:Abandoned', 'old');
    now += RETENTION_MS;
    await store.chain.putPending('upto:x:Recent', 'new');
    now += 1;
    await store.channels.put(record('Open2'));
    assert.deepEqual(
      (await store.channels.list()).map((entry) => entry.channelId).sort(),
      ['Open1', 'Open2'],
    );
    // A pending signature outlives its channel by at most the retention, whatever its key.
    assert.equal(await store.chain.getPending('upto:x:Abandoned'), undefined);
    assert.equal(await store.chain.getPending('upto:x:Recent'), 'new');
    // With the cap reached by active channels, a new channel is refused rather than evicting one.
    await store.channels.put(record('Open3'));
    await assert.rejects(store.channels.put(record('Open4')), unavailable);
    await store.channels.put(record('Open1', UPTO_CHANNEL_STATES.SETTLING));
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a restarted seller settles and recovers what the previous process left', async () => {
  const root = await directory();
  try {
    const deposits = new Set<string>();
    const chain: UptoChain = {
      verify: async () => true,
      async deposit(authorization) {
        deposits.add(authorization.channelId);
        if (authorization.channelId === 'InFlight') throw new Error('crash');
        return { transaction: 'd' };
      },
      depositState: async (channelId) =>
        deposits.has(channelId)
          ? UPTO_DEPOSIT_STATES.LANDED
          : UPTO_DEPOSIT_STATES.NEVER,
      claim: async () => ({ transaction: 'c' }),
    };
    const opened: { close(): Promise<void> }[] = [];
    const start = async () => {
      const store = await ledger(root);
      opened.push(store);
      return createUptoSeller({
        chain,
        store: store.channels,
        now: () => NOW,
        own: record('x').terms,
      });
    };
    const first = await start();
    const admitted = record('Admitted');
    await first.admit(
      {
        channelId: 'Admitted',
        payer: admitted.payer,
        maxAtomic: admitted.maxAtomic,
        payload: admitted.payload,
      },
      admitted.terms,
    );
    await assert.rejects(
      first.admit(
        {
          channelId: 'InFlight',
          payer: admitted.payer,
          maxAtomic: admitted.maxAtomic,
          payload: admitted.payload,
        },
        admitted.terms,
      ),
    );
    // The first process exits before the second starts.
    await opened[0]?.close();
    const second = await start();
    assert.equal((await second.settle('Admitted', '5')).chargedAtomic, '5');
    assert.deepEqual(
      (await second.recover()).map((entry) => [entry.channelId, entry.state]),
      [['InFlight', UPTO_CHANNEL_STATES.ADMITTED]],
    );
    await opened[1]?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
