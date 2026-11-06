// The doctor for a seller with paid offers: the same verdict as startup for the payout and payment
// keys, from file metadata only, and with --online a warning for token accounts startup will create.
// Synthetic homes and keys; nothing is read from a real role, and the chain is a probe.
import assert from 'node:assert/strict';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET_GENESIS, PROTOCOL_FEE } from '@gyblos/config';

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
    for (const payTo of [role.authorizer, role.facilitator]) {
      await writeFile(rolePath, JSON.stringify({ ...role, payTo }));
      assert.match(
        line((await doctor(run)).output, 'payments'),
        /FAIL\s+payments\s+SELLER_PAYMENT_DESCRIPTION_INVALID/,
      );
    }
  }));

void test('doctor --online: missing payment token accounts warn, an unreadable RPC warns, another chain fails, offline never asks', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), paidToml(run));
    const asked: { mint: string; owners: readonly string[] }[] = [];
    const missing = await doctor(
      run,
      ['--online'],
      {},
      {
        genesis: async () => DEVNET_GENESIS,
        paymentAccounts: async ({ mint, owners }) => {
          asked.push({ mint, owners });
          return { missing: 2, unusable: 0 };
        },
      },
    );
    // A warning, not a failure: startup creates them.
    assert.equal(missing.code, 0);
    assert.match(
      line(missing.output, 'payments'),
      /WARN\s+payments\s+PAYMENT_ACCOUNTS_MISSING\s+startup creates/,
    );
    const role = JSON.parse(
      await readFile(join(run.seller, 'role.json'), 'utf8'),
    ) as { mint: string; payTo: string; facilitator: string };
    assert.deepEqual(asked, [
      {
        mint: role.mint,
        owners: [role.payTo, PROTOCOL_FEE.treasury, role.facilitator],
      },
    ]);
    const unreadable = await doctor(
      run,
      ['--online'],
      {},
      {
        genesis: async () => DEVNET_GENESIS,
        paymentAccounts: async () => {
          throw new Error('rpc down at https://rpc.example/?key=s');
        },
      },
    );
    assert.equal(unreadable.code, 0);
    assert.match(
      line(unreadable.output, 'payments'),
      /WARN\s+payments\s+PAYMENT_ACCOUNTS_UNCHECKED/,
    );
    assert.equal(unreadable.output.includes('rpc.example'), false);
    const offline = await doctor(
      run,
      [],
      {},
      {
        paymentAccounts: async () => {
          throw new Error('never asked without --online');
        },
      },
    );
    assert.match(line(offline.output, 'payments'), /^\s*OK\s+payments/);
    // Another chain fails as startup would, and an unreadable genesis warns; neither reads accounts.
    let read = 0;
    const never = async () => {
      read += 1;
      return { missing: 0, unusable: 0 };
    };
    const mainnet = await doctor(
      run,
      ['--online'],
      {},
      { genesis: async () => 'another chain', paymentAccounts: never },
    );
    assert.equal(mainnet.code, 1);
    assert.match(
      line(mainnet.output, 'payments'),
      /FAIL\s+payments\s+SELLER_PAYMENT_NETWORK_MISMATCH/,
    );
    const silent = await doctor(
      run,
      ['--online'],
      {},
      {
        genesis: async () => {
          throw new Error('rpc down at https://rpc.example/?key=s');
        },
        paymentAccounts: never,
      },
    );
    assert.equal(silent.code, 0);
    assert.match(
      line(silent.output, 'payments'),
      /WARN\s+payments\s+PAYMENT_ACCOUNTS_UNCHECKED/,
    );
    assert.equal(silent.output.includes('rpc.example'), false);
    assert.equal(read, 0);
    // A frozen account fails: startup refuses it.
    const frozen = await doctor(
      run,
      ['--online'],
      {},
      {
        genesis: async () => DEVNET_GENESIS,
        paymentAccounts: async () => ({ missing: 1, unusable: 1 }),
      },
    );
    assert.equal(frozen.code, 1);
    assert.match(
      line(frozen.output, 'payments'),
      /FAIL\s+payments\s+PAYMENT_ACCOUNTS_UNUSABLE\s+a payout/,
    );
  }));

void test('doctor accepts a paid seller whose payout is its owner', () =>
  scenario({}, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), paidToml(run));
    const rolePath = join(run.seller, 'role.json');
    const role = JSON.parse(await readFile(rolePath, 'utf8'));
    await writeFile(rolePath, JSON.stringify({ ...role, payTo: role.owner }));
    assert.match(
      line((await doctor(run)).output, 'payments'),
      /^\s*OK\s+payments/,
    );
  }));
