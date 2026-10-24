// Disposable-session cleanup must never strand Electron in an error dialog.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cleanupDesktopSession } from '@gyblos/desktop/session-cleanup';

void test('desktop session cleanup removes its disposable directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gyblos-session-cleanup-'));
  try {
    writeFileSync(join(directory, 'synthetic-cache'), 'synthetic');
    let reports = 0;
    assert.equal(
      cleanupDesktopSession(directory, () => {
        reports += 1;
      }),
      true,
    );
    assert.equal(existsSync(directory), false);
    assert.equal(reports, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('a racing Chromium session cleanup failure is reported without interrupting quit', () => {
  let reports = 0;
  const failure = Object.assign(new Error('synthetic private path'), {
    code: 'ENOTEMPTY',
  });
  const cleaned = cleanupDesktopSession(
    'unused-synthetic-path',
    () => {
      reports += 1;
    },
    () => {
      throw failure;
    },
  );
  assert.equal(cleaned, false);
  assert.equal(reports, 1);
});
