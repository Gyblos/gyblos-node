// Exercises opt-in configuration and lifecycle ownership using synthetic metadata and temporary homes.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FILE_MODES, ROLE_FILES, rolePathIn } from '@gyblos/config';
import { NODE_ERROR_CODES, NODE_SETTINGS } from '@gyblos/node/constants';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { resolveNodeConfig } from '@gyblos/node/node-config-resolve';
import { createLocalTelemetry, loadLocalTelemetry } from '@gyblos/node/telemetry-startup';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';

import { telemetryEvents } from './support/receipt-fixture';

const BASE = 'version = 1\n[node]\nnetwork = "devnet"\n';
void test('local telemetry defaults off and validates the file-only opt-in strictly', () => {
  for (const file of [undefined, false, true]) {
    const parsed = parseNodeConfig(BASE + (file === undefined ? '' : `\n[telemetry]\nfile = ${file}\n`));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const resolved = resolveNodeConfig({ file: parsed.config, env: {} });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.settings.telemetryFile, file ?? false);
    assert.equal(resolved.origins.find((origin) => origin.setting === NODE_SETTINGS.TELEMETRY_FILE)?.name, file === undefined ? 'default' : 'telemetry.file');
  }
  for (const value of ['file = "true"', 'file = 1', 'endpoint = "synthetic-secret"']) {
    const parsed = parseNodeConfig(BASE + '\n[telemetry]\n' + value);
    assert.equal(parsed.ok, false);
    assert.ok(!JSON.stringify(parsed).includes('synthetic-secret'));
  }
});
void test('buyer telemetry reads only the selected TOML and refuses an invalid explicit file statically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-startup-telemetry-'));
  try {
    assert.equal(await loadLocalTelemetry({}, root), false);
    const path = join(root, 'selected.toml');
    await writeFile(path, BASE + '\n[telemetry]\nfile = true\n');
    assert.equal(await loadLocalTelemetry({ GYBLOS_CONFIG: path }, root), true);
    await writeFile(path, BASE + '\n[telemetry]\nfile = "synthetic-secret"\n');
    await assert.rejects(loadLocalTelemetry({ GYBLOS_CONFIG: path }, root), { code: NODE_ERROR_CODES.NODE_CONFIG_INVALID, message: NODE_ERROR_CODES.NODE_CONFIG_INVALID });
    await assert.rejects(loadLocalTelemetry({ GYBLOS_CONFIG: join(root, 'missing') }, root), { code: NODE_ERROR_CODES.NODE_CONFIG_INVALID });
    assert.deepEqual((await readdir(root)).sort(), ['selected.toml']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
void test('disabled local telemetry creates no sink or filesystem state', async () => {
  let created = 0;
  const local = createLocalTelemetry({ enabled: false, environment: {}, role: P2P_ROLES.BUYER, createSink() { created++; throw new Error('synthetic'); } });
  assert.equal(local.sink, undefined);
  await local.close();
  assert.equal(created, 0);
  assert.deepEqual(local.health(), { enabled: false, owned: false, closed: true, failed: false });
});
void test('a caller-supplied telemetry sink remains caller-owned even with file logging enabled', async () => {
  let closed = 0;
  const sink: TelemetrySink = { emit() {}, async flush() {}, async close() { closed++; return { emitted: 0, dropped: 0, failed: false }; } };
  const local = createLocalTelemetry({ enabled: true, environment: {}, role: P2P_ROLES.BUYER, sink, createSink() { throw new Error('must not construct another sink'); } });
  assert.equal(local.sink, sink);
  await local.close();
  assert.equal(closed, 0);
  assert.deepEqual(local.health(), { enabled: true, owned: false, closed: true, failed: false });
});
void test('owned file telemetry is lazy, role-private and drained exactly once on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-startup-log-'));
  const environment = { GYBLOS_HOME: root };
  try {
    for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER]) {
      const local = createLocalTelemetry({ enabled: true, environment, role });
      assert.ok(local.sink);
      assert.deepEqual(await readdir(root), role === P2P_ROLES.BUYER ? [] : [P2P_ROLES.BUYER]);
      local.sink.emit(telemetryEvents()[0]!);
      await Promise.all([local.close(), local.close()]);
      const directory = rolePathIn(environment, role, ROLE_FILES.telemetry);
      assert.equal((await stat(directory)).mode & FILE_MODES.permissionMask, FILE_MODES.privateDirectory);
      const names = await readdir(directory);
      assert.equal(names.length, 1);
      const file = join(directory, names[0]!);
      assert.equal((await stat(file)).mode & FILE_MODES.permissionMask, FILE_MODES.privateFile);
      const before = await readFile(file, 'utf8');
      assert.equal(before.trim().split('\n').length, 1);
      local.sink.emit(telemetryEvents()[0]!);
      await local.close();
      assert.equal(await readFile(file, 'utf8'), before);
      assert.deepEqual(local.health(), { enabled: true, owned: true, closed: true, failed: false });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
void test('sink construction, emission and close failures never escape and degrade local health', async () => {
  const unavailable = createLocalTelemetry({ enabled: true, environment: {}, role: P2P_ROLES.SELLER, createSink() { throw new Error('synthetic-secret'); } });
  await unavailable.close();
  assert.equal(unavailable.health().failed, true);
  let closed = 0;
  const local = createLocalTelemetry({ enabled: true, environment: {}, role: P2P_ROLES.SELLER, createSink: () => ({ emit() { throw new Error('synthetic-secret'); }, async flush() { throw new Error('synthetic-secret'); }, async close() { closed++; throw new Error('synthetic-secret'); } }) });
  local.sink?.emit(telemetryEvents()[0]!);
  await local.close();
  assert.equal(closed, 1);
  assert.equal(local.health().failed, true);
  assert.ok(!JSON.stringify(local.health()).includes('synthetic-secret'));
});
