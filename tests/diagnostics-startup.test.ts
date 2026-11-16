// Verifies independent diagnostic controls and owned lifecycle using temporary product homes.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { NODE_ENVIRONMENT, ROLE_FILES, rolePathIn } from '@gyblos/config';
import {
  createLocalDiagnostics,
  loadLocalDiagnostics,
} from '@gyblos/node/diagnostics-startup';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { DIAGNOSTIC_LEVELS } from '@gyblos/runtime/constants';
import {
  createDiagnostics,
  readDiagnostics,
} from '@gyblos/runtime/diagnostics';

const BASE = 'version = 1\n[node]\nnetwork = "devnet"\n';
void test('diagnostic configuration is strict and independent of telemetry', () => {
  const result = parseNodeConfig(
    BASE +
      '\n[telemetry]\nfile = false\n[diagnostics]\nenabled = true\nlevel = "debug"\n',
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.telemetry?.file, false);
    assert.equal(result.config.diagnostics?.level, DIAGNOSTIC_LEVELS.DEBUG);
  }
  for (const text of [
    'level = "SECRET-CANARY"',
    'enabled = "true"',
    'upload = true',
  ]) {
    const invalid = parseNodeConfig(BASE + '\n[diagnostics]\n' + text);
    assert.equal(invalid.ok, false);
    assert.ok(!JSON.stringify(invalid).includes('SECRET-CANARY'));
  }
});
void test('local diagnostics default to warnings, carry release version and close their own storage', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'gyb-diagnostics-startup-'),
  );
  const env = { GYBLOS_HOME: root, [NODE_ENVIRONMENT.version]: '0.1.0-beta.9' };
  const local = createLocalDiagnostics(env, 'buyer');
  const channel = createDiagnostics({
    component: 'synthetic',
    operation: 'request',
    phases: ['execute'],
    codes: ['FAILED'],
    level: DIAGNOSTIC_LEVELS.DEBUG,
    sink: local.write,
  });
  try {
    assert.deepEqual(await loadLocalDiagnostics(env, root), {});
    channel.start().report({
      phase: 'execute',
      code: 'FAILED',
      level: DIAGNOSTIC_LEVELS.DEBUG,
    });
    assert.deepEqual(await readdir(root), []);
    channel.start().report({ phase: 'execute', code: 'FAILED' });
    await local.close();
    const records = await readDiagnostics(
      rolePathIn(env, 'buyer', ROLE_FILES.diagnostics),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]?.version, env[NODE_ENVIRONMENT.version]);
    assert.equal(local.health().failed, false);
    assert.equal(local.health().closed, true);
  } finally {
    await local.close();
    await rm(root, { recursive: true, force: true });
  }
});

void test('local sink projects before touching hostile extra fields', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'gyb-diagnostics-projection-'),
  );
  const local = createLocalDiagnostics({ GYBLOS_HOME: root }, 'buyer');
  let accessed = false;
  try {
    createDiagnostics({
      component: 'synthetic',
      operation: 'request',
      phases: ['execute'],
      codes: ['FAILED'],
      sink: (record) => {
        Object.defineProperty(record, 'extra', {
          enumerable: true,
          get() {
            accessed = true;
            throw new Error('SECRET-CANARY');
          },
        });
        local.write(record);
      },
    })
      .start()
      .report({ phase: 'execute', code: 'FAILED' });
    assert.equal(accessed, false);
  } finally {
    await local.close();
    await rm(root, { recursive: true, force: true });
  }
});
