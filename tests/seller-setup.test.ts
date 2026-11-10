// Every seller needs only --mint and gets owner, node and payment keys paid to its owner, so any offer can
// be free or priced. A seller created without payment keys (earlier releases' free setup) gets them on the
// next setup, keeping its NodeId and owner; existing paid roles, including earlier releases' `buyer` field,
// keep loading unchanged. Disposable homes; no RPC, funding or network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import {
  FILE_MODES,
  homeLayout,
  ROLE_FILES,
  ROLE_KEY_FILES,
} from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import {
  NODE_ERROR_CODES,
  ROLE_CONFIG_SCHEMA_VERSION,
} from '@gyblos/node/constants';
import { parseRoleConfig, SELLER_PAYMENT_FIELDS } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime';
import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const ROLE_OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };
const MINT = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
const NODE_ID =
  '5482bad2e0f534be4d92525ff99953bc146531e1696d43e92289f246ef0bd738';
const PAID_KEYS = [
  ROLE_KEY_FILES.owner,
  ROLE_KEY_FILES.authorizer,
  ROLE_KEY_FILES.facilitator,
  ROLE_FILES.nodeKey,
].sort();

async function addresses(count: number) {
  return Promise.all(
    Array.from(
      { length: count },
      async () => (await generateKeyPairSigner()).address,
    ),
  );
}

async function paidRole() {
  const [owner, authorizer, facilitator, payTo] = await addresses(4);
  return {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    role: P2P_ROLES.SELLER,
    rpcUrl: 'https://api.devnet.solana.com',
    mint: MINT,
    assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
    nodeId: NODE_ID,
    owner,
    authorizer,
    facilitator,
    payTo,
  };
}

function setup(home: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'apps/node/src/bin.ts', 'setup', ...args],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        GYBLOS_HOME: home,
      },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
}

void test('seller role files: payment fields all or none, and an earlier buyer field is ignored', async () => {
  const paid = await paidRole();
  assert.deepEqual(parseRoleConfig(paid), paid);
  const [legacyBuyer] = await addresses(1);
  assert.deepEqual(parseRoleConfig({ ...paid, buyer: legacyBuyer }), paid);
  const free = Object.fromEntries(
    Object.entries(paid).filter(
      ([key]) => !(SELLER_PAYMENT_FIELDS as readonly string[]).includes(key),
    ),
  );
  assert.deepEqual(parseRoleConfig(free), free);
  for (const field of SELLER_PAYMENT_FIELDS)
    assert.throws(
      () => parseRoleConfig({ ...free, [field]: paid[field] }),
      { code: NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION },
      field,
    );
});

void test(
  'seller setup creates payment keys paid to the owner and is idempotent',
  ROLE_OPTIONS,
  async () => {
    const { setupRole, publicRole, roleSigner } =
      await import('@gyblos/node/roles');
    const original = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-seller-setup-'));
    try {
      process.chdir(directory);
      const first = await setupRole({ role: P2P_ROLES.SELLER, mint: MINT });
      if (first.role !== P2P_ROLES.SELLER) throw new Error('unexpected role');
      assert.equal(first.payTo, first.owner);
      assert.deepEqual(
        (await readdir(homeLayout(process.env).roles.seller)).sort(),
        [...PAID_KEYS, ROLE_FILES.roleConfig].sort(),
      );
      assert.deepEqual(
        await setupRole({ role: P2P_ROLES.SELLER, mint: MINT }),
        first,
      );
      const report = await publicRole(P2P_ROLES.SELLER);
      assert.deepEqual(report.keys.map((key) => key.name).sort(), PAID_KEYS);
      assert.ok(
        report.keys.every((key) => key.mode === FILE_MODES.privateFile),
      );
      assert.equal('buyer' in report, false);
      await roleSigner(P2P_ROLES.SELLER, 'authorizer');
      await roleSigner(P2P_ROLES.SELLER, 'facilitator');
    } finally {
      process.chdir(original);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'a seller created without payment keys gets them, keeping its NodeId, owner and keys',
  ROLE_OPTIONS,
  async () => {
    const { setupRole, roleSigner } = await import('@gyblos/node/roles');
    const original = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-seller-upgrade-'));
    try {
      process.chdir(directory);
      const created = await setupRole({ role: P2P_ROLES.SELLER, mint: MINT });
      if (created.role !== P2P_ROLES.SELLER) throw new Error('unexpected role');
      const sellerDirectory = homeLayout(process.env).roles.seller;
      // What earlier releases' free setup left: owner and node keys only, no payment fields.
      for (const name of [
        ROLE_KEY_FILES.authorizer,
        ROLE_KEY_FILES.facilitator,
      ])
        await rm(join(sellerDirectory, name));
      const free = Object.fromEntries(
        Object.entries(created).filter(
          ([key]) =>
            !(SELLER_PAYMENT_FIELDS as readonly string[]).includes(key),
        ),
      );
      await writeFile(
        join(sellerDirectory, ROLE_FILES.roleConfig),
        JSON.stringify(free),
      );
      const ownerKey = await readFile(
        join(sellerDirectory, ROLE_KEY_FILES.owner),
        'utf8',
      );
      const nodeKey = await readFile(
        join(sellerDirectory, ROLE_FILES.nodeKey),
        'utf8',
      );
      const upgraded = await setupRole({ role: P2P_ROLES.SELLER, mint: MINT });
      if (upgraded.role !== P2P_ROLES.SELLER)
        throw new Error('unexpected role');
      assert.equal(upgraded.nodeId, created.nodeId);
      assert.equal(upgraded.owner, created.owner);
      assert.equal(upgraded.payTo, created.owner);
      assert.notEqual(upgraded.authorizer, created.authorizer);
      assert.equal(
        await readFile(join(sellerDirectory, ROLE_KEY_FILES.owner), 'utf8'),
        ownerKey,
      );
      assert.equal(
        await readFile(join(sellerDirectory, ROLE_FILES.nodeKey), 'utf8'),
        nodeKey,
      );
      // Earlier releases read the payment fields only with a buyer, so the file keeps one: the owner.
      assert.deepEqual(
        JSON.parse(
          await readFile(join(sellerDirectory, ROLE_FILES.roleConfig), 'utf8'),
        ),
        { ...upgraded, buyer: upgraded.owner },
      );
      await roleSigner(P2P_ROLES.SELLER, 'facilitator');
      assert.deepEqual(
        await setupRole({ role: P2P_ROLES.SELLER, mint: MINT }),
        upgraded,
      );
    } finally {
      process.chdir(original);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'node:setup needs only --mint, refuses the retired --buyer and --pay-to, and names a bad mint',
  ROLE_OPTIONS,
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'gyblos-setup-cli-'));
    try {
      const [valid] = await addresses(1);
      for (const flag of ['--buyer', '--pay-to']) {
        const retired = setup(home, [
          '--role',
          'seller',
          '--mint',
          MINT,
          flag,
          valid!,
        ]);
        assert.equal(retired.status, 1, flag);
        assert.match(retired.stderr, /--buyer and --pay-to are no longer used/);
      }
      const bad = setup(home, ['--role', 'buyer', '--mint', 'MINT']);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /--mint is not a valid Solana address/);
      assert.doesNotMatch(bad.stderr, /SolanaError/);
      assert.deepEqual(await readdir(home), []);
      const result = setup(home, ['--role', 'seller', '--mint', MINT]);
      assert.equal(result.status, 0, result.stderr);
      const printed = JSON.parse(result.stdout) as Record<string, unknown>;
      const saved = JSON.parse(
        await readFile(join(home, 'seller', ROLE_FILES.roleConfig), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(printed.nodeId, saved.nodeId);
      assert.equal(printed.owner, saved.owner);
      assert.equal(saved.payTo, saved.owner);
      // All four fields earlier releases require, so an older image still loads it.
      for (const field of ['authorizer', 'facilitator', 'payTo', 'buyer'])
        assert.equal(typeof saved[field], 'string', field);
      assert.equal(saved.buyer, saved.owner);
      assert.equal('buyer' in printed, false);
      assert.equal(printed.payTo, saved.owner);
      const repeat = setup(home, ['--role', 'seller', '--mint', MINT]);
      assert.equal(repeat.status, 0, repeat.stderr);
      assert.deepEqual(JSON.parse(repeat.stdout), printed);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
