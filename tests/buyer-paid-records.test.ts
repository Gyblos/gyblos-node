// The paid buyer's outcome records: private JSON lines with identifiers and amounts only, never written
// through a planted link, and refused once the file is full. Temporary directories; no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PAID_BUYER, PAID_VERDICTS } from '@gyblos/buyer/constants';
import { paidRecords } from '@gyblos/buyer/paid-records';
import { FILE_MODES } from '@gyblos/config';

const RECORD = {
  nodeId: 'a'.repeat(64),
  requestDigest: 'b'.repeat(64),
  channelId: 'Chan111111111111111111111111111111111111111',
  verdict: PAID_VERDICTS.DISPUTED,
  expectedAtomic: '1',
  claimedAtomic: '2',
};

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-paid-records-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('records are private JSON lines holding only identifiers and amounts', () =>
  withDirectory(async (directory) => {
    const path = join(directory, PAID_BUYER.recordsFile);
    const records = paidRecords(path);
    // Extra fields a caller might pass never reach the file.
    await records.record({ ...RECORD, ...{ payload: 'signed-open' } });
    await records.record({ ...RECORD, verdict: PAID_VERDICTS.REFUSED });
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.deepEqual(
      lines.map((line) => JSON.parse(line) as unknown),
      [RECORD, { ...RECORD, verdict: PAID_VERDICTS.REFUSED }],
    );
    assert.equal(
      (await lstat(path)).mode & FILE_MODES.permissionMask,
      FILE_MODES.privateFile,
    );
    // A file left readable by others is made private again.
    await chmod(path, 0o644);
    await records.record(RECORD);
    assert.equal(
      (await lstat(path)).mode & FILE_MODES.permissionMask,
      FILE_MODES.privateFile,
    );
  }));

void test('a planted link, FIFO or hard link, or a full file, refuses the record', () =>
  withDirectory(async (directory) => {
    const fifo = join(directory, 'fifo.jsonl');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    await assert.rejects(paidRecords(fifo).record(RECORD));
    const shared = join(directory, 'shared');
    await writeFile(shared, '');
    const hard = join(directory, 'hard.jsonl');
    await link(shared, hard);
    await assert.rejects(paidRecords(hard).record(RECORD));
    assert.equal(await readFile(shared, 'utf8'), '');
    const target = join(directory, 'elsewhere');
    await writeFile(target, '');
    const linked = join(directory, 'linked.jsonl');
    await symlink(target, linked);
    await assert.rejects(paidRecords(linked).record(RECORD));
    assert.equal(await readFile(target, 'utf8'), '');
    const full = join(directory, 'full.jsonl');
    await writeFile(full, 'x'.repeat(PAID_BUYER.recordsBytes - 10));
    await assert.rejects(paidRecords(full).record(RECORD));
  }));
