// A free seller sets up with only --mint: node:setup creates the owner and node keys and no paid
// roles, while the paid pair (--buyer with --pay-to) stays all-or-nothing and existing paid role files
// keep loading. Disposable homes; no RPC, funding or network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { homeLayout, ROLE_FILES, ROLE_KEY_FILES } from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { parseRoleConfig } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime';
import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const ROLE_OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };
const MINT = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
const NODE_ID =
  '5482bad2e0f534be4d92525ff99953bc146531e1696d43e92289f246ef0bd738';
const PAID_FIELDS = ['authorizer', 'facilitator', 'payTo', 'buyer'] as const;

async function addresses(count: number) {
  return Promise.all(
    Array.from(
      { length: count },
      async () => (await generateKeyPairSigner()).address,
    ),
  );
}

async function paidRole() {
  const [owner, authorizer, facilitator, payTo, buyer] = await addresses(5);
  return {
    schemaVersion: 1,
    role: P2P_ROLES.SELLER,
    rpcUrl: 'https://api.devnet.solana.com',
    mint: MINT,
    assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
    nodeId: NODE_ID,
    owner,
    authorizer,
    facilitator,
    payTo,
    buyer,
  };
}

function setup(home: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'apps/node/src/setup.ts', ...args],
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

void test('a seller role file without payment fields loads; a partial payment set is refused', async () => {
  const paid = await paidRole();
  assert.deepEqual(parseRoleConfig(paid), paid);
  const free = Object.fromEntries(
    Object.entries(paid).filter(
      ([key]) => !(PAID_FIELDS as readonly string[]).includes(key),
    ),
  );
  assert.deepEqual(parseRoleConfig(free), free);
  for (const field of PAID_FIELDS)
    assert.throws(
      () => parseRoleConfig({ ...free, [field]: paid[field] }),
      { code: NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION },
      field,
    );
});

void test(
  'free seller setup creates only the owner and node keys and is idempotent',
  ROLE_OPTIONS,
  async () => {
    const { setupRole, publicRole, roleSigner } =
      await import('@gyblos/node/roles');
    const original = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-free-seller-'));
    try {
      process.chdir(directory);
      const first = await setupRole({ role: P2P_ROLES.SELLER, mint: MINT });
      assert.equal(first.role, P2P_ROLES.SELLER);
      for (const field of PAID_FIELDS) assert.equal(field in first, false);
      assert.deepEqual(
        (await readdir(homeLayout(process.env).roles.seller)).sort(),
        [
          ROLE_KEY_FILES.owner,
          ROLE_FILES.nodeKey,
          ROLE_FILES.roleConfig,
        ].sort(),
      );
      assert.deepEqual(
        await setupRole({ role: P2P_ROLES.SELLER, mint: MINT }),
        first,
      );
      const report = await publicRole(P2P_ROLES.SELLER);
      assert.deepEqual(report.keys.map((key) => key.name).sort(), [
        ROLE_FILES.nodeKey,
        ROLE_KEY_FILES.owner,
      ]);
      for (const field of PAID_FIELDS) assert.equal(field in report, false);
      await roleSigner(P2P_ROLES.SELLER, 'owner');
      await assert.rejects(roleSigner(P2P_ROLES.SELLER, 'authorizer'));
      const [buyer, payTo] = await addresses(2);
      await assert.rejects(
        setupRole({ role: P2P_ROLES.SELLER, mint: MINT, buyer, payTo }),
        /preserved/,
      );
    } finally {
      process.chdir(original);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'node:setup needs only --mint for a seller and keeps --buyer/--pay-to as a pair',
  ROLE_OPTIONS,
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'gyblos-free-setup-cli-'));
    try {
      const [buyer] = await addresses(1);
      const half = setup(home, [
        '--role',
        'seller',
        '--mint',
        MINT,
        '--buyer',
        buyer!,
      ]);
      assert.equal(half.status, 1);
      assert.match(half.stderr, /--buyer and --pay-to together/);
      const result = setup(home, ['--role', 'seller', '--mint', MINT]);
      assert.equal(result.status, 0, result.stderr);
      const printed: unknown = JSON.parse(result.stdout);
      const saved: unknown = JSON.parse(
        await readFile(join(home, 'seller', ROLE_FILES.roleConfig), 'utf8'),
      );
      assert.ok(printed && typeof printed === 'object');
      assert.ok(saved && typeof saved === 'object');
      assert.equal(
        'nodeId' in printed && printed.nodeId,
        'nodeId' in saved && saved.nodeId,
      );
      assert.equal(
        'owner' in printed && printed.owner,
        'owner' in saved && saved.owner,
      );
      assert.equal('payTo' in printed, false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
