// Exercises read-only local diagnostic CLI output against a temporary role home.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ROLE_FILES, rolePathIn } from '@gyblos/config/home';
import { runCli } from '@gyblos/node-app/cli';
import {
  createDiagnosticLog,
  createDiagnostics,
} from '@gyblos/runtime/diagnostics';

void test('logs CLI reads the selected temporary role as JSON without changing the files', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gyb-logs-cli-'));
  const env = { GYBLOS_HOME: root };
  const log = createDiagnosticLog(
    rolePathIn(env, 'buyer', ROLE_FILES.diagnostics),
  );
  let stdout = '';
  let stderr = '';
  try {
    createDiagnostics({
      component: 'synthetic',
      operation: 'request',
      phases: ['execute'],
      codes: ['FAILED'],
      sink: log.write,
    })
      .start()
      .report({ phase: 'execute', code: 'FAILED' });
    await log.close();
    const code = await runCli(['logs', '--role', 'buyer', '--json'], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.equal(JSON.parse(stdout).phase, 'execute');
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});
