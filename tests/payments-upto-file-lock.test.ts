// The durable upto ledger's ownership: one live process holds it, a dead owner on this host is
// taken over, a lost lock stops writes, close drains and refuses, and retention has a floor.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import test from 'node:test';

import {
  directory,
  ledger,
  paths,
  record,
  RETENTION_MS,
  session,
  unavailable,
} from './support/payment-upto-file';

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

void test('close refuses new writes at once, finishes queued ones and can be repeated', async () => {
  const root = await directory();
  try {
    const store = await ledger(root);
    const queued = store.channels.put(record('Chan1'));
    const closed = store.close();
    await assert.rejects(store.channels.put(record('Chan2')), unavailable);
    await queued;
    await closed;
    await store.close();
    assert.deepEqual(
      (await session(root, (next) => next.channels.list())).map(
        (entry) => entry.channelId,
      ),
      ['Chan1'],
    );
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
