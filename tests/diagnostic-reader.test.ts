// Exercises bounded read-only log snapshots and follow with synthetic private temporary files.
import assert from 'node:assert/strict';
import {
  appendFile,
  link,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DIAGNOSTIC_READ_ERROR } from '@gyblos/runtime/constants';
import {
  createDiagnosticLog,
  createDiagnostics,
  followDiagnostics,
  readDiagnostics,
  type DiagnosticRecord,
} from '@gyblos/runtime/diagnostics';

async function fixture() {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'gyb-diagnostic-reader-'),
  );
  const directory = join(root, 'diagnostics');
  const log = createDiagnosticLog(directory);
  const channel = createDiagnostics({
    component: 'synthetic',
    operation: 'request',
    phases: ['execute'],
    codes: ['FAILED'],
    sink: log.write,
  });
  const emit = () =>
    channel.start().report({ phase: 'execute', code: 'FAILED' });
  return {
    root,
    directory,
    log,
    emit,
    close: async () => {
      await log.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
void test('diagnostic snapshots handle appends and torn tails and filter by correlation', async () => {
  const source = await fixture();
  try {
    source.emit();
    await source.log.flush();
    const first = await readDiagnostics(source.directory);
    assert.equal(first.length, 1);
    source.emit();
    await source.log.close();
    const all = await readDiagnostics(source.directory);
    assert.equal(all.length, 2);
    assert.equal(
      (
        await readDiagnostics(source.directory, {
          correlationId: first[0]!.correlationId,
        })
      ).length,
      1,
    );
    assert.equal(
      (await readDiagnostics(source.directory, { component: 'other' })).length,
      0,
    );
    await appendFile(
      join(source.directory, (await readdir(source.directory))[0]!),
      '{"unfinished":',
    );
    await appendFile(
      join(source.directory, (await readdir(source.directory))[0]!),
      Buffer.from([0xe2]),
    );
    assert.deepEqual(await readDiagnostics(source.directory), all);
  } finally {
    await source.close();
  }
});
void test(
  'follow emits each retained record once and stops on cancellation',
  { timeout: 5000 },
  async () => {
    const source = await fixture();
    const controller = new AbortController();
    const observed: DiagnosticRecord[] = [];
    try {
      source.emit();
      await source.log.flush();
      let started: () => void = () => {};
      const first = new Promise<void>((resolve) => {
        started = resolve;
      });
      const following = followDiagnostics(
        source.directory,
        (record) => {
          observed.push(record);
          started();
          if (observed.length === 2) controller.abort();
        },
        controller.signal,
      );
      try {
        await first;
        source.emit();
        await source.log.flush();
        await following;
        assert.equal(observed.length, 2);
        assert.notEqual(observed[0]!.id, observed[1]!.id);
      } finally {
        controller.abort();
        await following;
      }
    } finally {
      await source.close();
    }
  },
);
void test('reader refuses symlinked directories, hard links and malformed complete records with static errors', async () => {
  const source = await fixture();
  try {
    source.emit();
    await source.log.close();
    const alias = join(source.root, 'alias');
    await symlink(
      source.directory,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(readDiagnostics(alias), {
      message: DIAGNOSTIC_READ_ERROR,
    });
    const path = join(source.directory, (await readdir(source.directory))[0]!);
    const second = join(source.root, 'second');
    await link(path, second);
    await assert.rejects(readDiagnostics(source.directory), {
      message: DIAGNOSTIC_READ_ERROR,
    });
    await rm(second);
    await appendFile(path, 'SECRET-CANARY\n');
    await assert.rejects(readDiagnostics(source.directory), {
      message: DIAGNOSTIC_READ_ERROR,
    });
  } finally {
    await source.close();
  }
});
void test('unused and disabled diagnostics create no profile', async () => {
  const source = await fixture();
  try {
    assert.equal((await readdir(source.root)).length, 0);
    assert.deepEqual(await readDiagnostics(source.directory), []);
    createDiagnostics({
      component: 'synthetic',
      operation: 'request',
      phases: ['execute'],
      codes: ['FAILED'],
      enabled: false,
      sink: source.log.write,
    })
      .start()
      .report({ phase: 'execute', code: 'FAILED' });
    await source.log.close();
    assert.equal((await readdir(source.root)).length, 0);
  } finally {
    await source.close();
  }
});
