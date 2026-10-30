// The doctor for a seller with paid offers: the same verdict as startup for the payout and payment
// keys, from file metadata only. Synthetic homes and keys; nothing is read from a real role.
import assert from 'node:assert/strict';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  doctor,
  freeToml,
  line,
  paidToml,
  REMOTE_FREE,
  scenario,
  withOllama,
} from './support/doctor-fixture';

void test('doctor: a paid offer is checked like startup, with the payout and payment keys', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), paidToml(run));
    const paid = await doctor(run);
    assert.match(line(paid.output, 'config'), /^\s*OK\s+config/);
    assert.match(line(paid.output, 'payments'), /^\s*OK\s+payments/);
    assert.match(paid.output, /offer\[1\] paid qwen3-0\.6b/);
    // Free sellers never see the payments line.
    await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
    assert.doesNotMatch((await doctor(run)).output, /payments/);
    await writeFile(join(run.root, 'gyblos.toml'), paidToml(run));
    await unlink(join(run.seller, 'facilitator.json'));
    const noKey = await doctor(run);
    assert.equal(noKey.code, 1);
    assert.match(
      line(noKey.output, 'payments'),
      /FAIL\s+payments\s+KEYS_MISSING/,
    );
  }));

void test('doctor: a paid offer on a seller set up without a payout fails the payments check', () =>
  scenario({ free: true }, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), paidToml(run));
    const result = await doctor(run);
    assert.equal(result.code, 1);
    assert.match(
      line(result.output, 'payments'),
      /FAIL\s+payments\s+SELLER_PAYMENT_ROLE_MISSING/,
    );
  }));

void test('doctor: a payout on a signing key or loose payment key files fail payments; mixed offers check once', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    const mixed = paidToml(run) + REMOTE_FREE.split('\n').slice(3).join('\n');
    await writeFile(join(run.root, 'gyblos.toml'), mixed);
    const both = await doctor(run, [], { UPSTREAM_API_KEY: 'synthetic' });
    assert.match(line(both.output, 'config'), /^\s*OK\s+config/);
    assert.equal(both.output.match(/payments/g)?.length, 1);
    await writeFile(join(run.root, 'gyblos.toml'), paidToml(run));
    await chmod(join(run.seller, 'authorizer.json'), 0o644);
    assert.match(
      line((await doctor(run)).output, 'payments'),
      /FAIL\s+payments\s+KEY_PERMISSIONS/,
    );
    await chmod(join(run.seller, 'authorizer.json'), 0o600);
    const rolePath = join(run.seller, 'role.json');
    const role = JSON.parse(await readFile(rolePath, 'utf8'));
    await writeFile(rolePath, JSON.stringify({ ...role, payTo: role.owner }));
    assert.match(
      line((await doctor(run)).output, 'payments'),
      /FAIL\s+payments\s+SELLER_PAYMENT_DESCRIPTION_INVALID/,
    );
  }));
