// Checks that role setup generates and keeps only its own keys, fails closed on insecure file modes, and
// that seller setup stores no buyer or payout key.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
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
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime';

const ROLE_OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };
const MINT = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';

void test(
  'role setup generates only its own keys and preserves them; insecure modes fail closed',
  ROLE_OPTIONS,
  async () => {
    const { setupRole, nodeSecret, publicRole, rolePath, roleSigner } =
      await import('@gyblos/node/roles');
    const original = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-role-test-'));
    try {
      process.chdir(directory);
      const first = await setupRole({ role: P2P_ROLES.BUYER, mint: MINT });
      assert.deepEqual(
        await setupRole({ role: P2P_ROLES.BUYER, mint: MINT }),
        first,
      );
      assert.deepEqual(
        (await readdir(homeLayout(process.env).roles.buyer)).sort(),
        [
          ROLE_KEY_FILES.buyer,
          ROLE_FILES.nodeKey,
          ROLE_FILES.roleConfig,
        ].sort(),
      );
      const report = await publicRole(P2P_ROLES.BUYER);
      assert.ok(
        report.keys.every((key) => key.mode === FILE_MODES.privateFile),
      );
      await assert.rejects(roleSigner(P2P_ROLES.BUYER, 'owner'), /Cross-role/);
      await roleSigner(P2P_ROLES.BUYER, 'buyer');
      await chmod(rolePath(P2P_ROLES.BUYER, ROLE_FILES.nodeKey), 0o644);
      await assert.rejects(nodeSecret(P2P_ROLES.BUYER), /permissions/);
    } finally {
      process.chdir(original);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'seller setup creates owner, node and payment keys, no buyer key, and refuses another mint',
  ROLE_OPTIONS,
  async () => {
    const { setupRole, publicRole, roleSigner } =
      await import('@gyblos/node/roles');
    const original = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-seller-role-test-'));
    try {
      process.chdir(directory);
      const first = await setupRole({ role: P2P_ROLES.SELLER, mint: MINT });
      assert.equal(first.role, 'seller');
      assert.deepEqual(
        (await readdir(homeLayout(process.env).roles.seller)).sort(),
        [
          ROLE_KEY_FILES.owner,
          ROLE_KEY_FILES.authorizer,
          ROLE_KEY_FILES.facilitator,
          ROLE_FILES.nodeKey,
          ROLE_FILES.roleConfig,
        ].sort(),
      );
      assert.ok(
        (await publicRole(P2P_ROLES.SELLER)).keys.every(
          (key) => key.mode === FILE_MODES.privateFile,
        ),
      );
      await assert.rejects(roleSigner(P2P_ROLES.SELLER, 'buyer'), /Cross-role/);
      await roleSigner(P2P_ROLES.SELLER, 'owner');
      await assert.rejects(
        setupRole({
          role: P2P_ROLES.SELLER,
          mint: (await generateKeyPairSigner()).address,
        }),
        /preserved/,
      );
    } finally {
      process.chdir(original);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'a new seller pays its owner and keeps its role on repeat',
  ROLE_OPTIONS,
  async () => {
    const { setupRole } = await import('@gyblos/node/roles');
    const originalDirectory = process.cwd();
    const previousHome = process.env.GYBLOS_HOME;
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-paid-owner-test-'));
    try {
      process.chdir(directory);
      process.env.GYBLOS_HOME = join(directory, 'home');
      const first = await setupRole({ role: P2P_ROLES.SELLER, mint: MINT });
      assert.equal(first.role, P2P_ROLES.SELLER);
      if (first.role !== P2P_ROLES.SELLER) throw new Error('unexpected role');
      assert.equal(first.payTo, first.owner);
      assert.notEqual(first.facilitator, first.owner);
      assert.notEqual(first.authorizer, first.owner);
      assert.equal('buyer' in first, false);
      assert.deepEqual(
        await setupRole({ role: P2P_ROLES.SELLER, mint: MINT }),
        first,
      );
    } finally {
      process.chdir(originalDirectory);
      if (previousHome === undefined) delete process.env.GYBLOS_HOME;
      else process.env.GYBLOS_HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'an existing paid role with another payout or a legacy buyer field stays unchanged',
  ROLE_OPTIONS,
  async () => {
    const { setupRole } = await import('@gyblos/node/roles');
    const { readFile, writeFile } = await import('node:fs/promises');
    const originalDirectory = process.cwd();
    const previousHome = process.env.GYBLOS_HOME;
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-legacy-payout-'));
    const buyer = await generateKeyPairSigner();
    const legacyPayout = await generateKeyPairSigner();
    try {
      process.chdir(directory);
      process.env.GYBLOS_HOME = join(directory, 'home');
      const created = await setupRole({ role: P2P_ROLES.SELLER, mint: MINT });
      const path = join(
        homeLayout(process.env).roles.seller,
        ROLE_FILES.roleConfig,
      );
      const legacy = { ...created, payTo: legacyPayout.address };
      await writeFile(
        path,
        JSON.stringify({ ...legacy, buyer: buyer.address }),
      );
      const before = await readFile(path, 'utf8');
      assert.deepEqual(
        await setupRole({ role: P2P_ROLES.SELLER, mint: MINT }),
        legacy,
      );
      assert.equal(await readFile(path, 'utf8'), before);
    } finally {
      process.chdir(originalDirectory);
      if (previousHome === undefined) delete process.env.GYBLOS_HOME;
      else process.env.GYBLOS_HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
