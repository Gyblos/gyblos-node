import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import {
  nodeSecret,
  publicRole,
  rolePath,
  roleSigner,
  setupRole,
} from '@gyblos/cli/p2p/roles';
import { FILE_MODES, P2P } from '@gyblos/config';

const MINT = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';

test('role setup generates only its own keys and preserves them; insecure modes fail closed', async () => {
  const original = process.cwd(),
    directory = await mkdtemp(join(tmpdir(), 'gyblos-role-test-'));
  try {
    process.chdir(directory);
    const first = await setupRole({ role: 'buyer', mint: MINT });
    assert.deepEqual(await setupRole({ role: 'buyer', mint: MINT }), first);
    assert.deepEqual(
      (await readdir(P2P.root)).sort(),
      [P2P.keys.buyer, P2P.nodeKeyFilename, P2P.roleConfig].sort(),
    );
    const report = await publicRole();
    assert.ok(report.keys.every((key) => key.mode === FILE_MODES.privateFile));
    await assert.rejects(roleSigner('owner'), /Cross-role/);
    await roleSigner('buyer');
    await chmod(rolePath(P2P.nodeKeyFilename), 0o644);
    await assert.rejects(nodeSecret(), /permissions/);
  } finally {
    process.chdir(original);
    await rm(directory, { recursive: true, force: true });
  }
});

test('seller setup stores no buyer or payout key and rejects reconfiguration', async () => {
  const original = process.cwd(),
    directory = await mkdtemp(join(tmpdir(), 'gyblos-seller-role-test-'));
  const buyer = await generateKeyPairSigner(),
    payout = await generateKeyPairSigner();
  try {
    process.chdir(directory);
    const first = await setupRole({
      role: 'seller',
      mint: MINT,
      buyer: buyer.address,
      payTo: payout.address,
    });
    assert.equal(first.role, 'seller');
    assert.deepEqual(
      (await readdir(P2P.root)).sort(),
      [
        P2P.keys.owner,
        P2P.keys.authorizer,
        P2P.keys.facilitator,
        P2P.nodeKeyFilename,
        P2P.roleConfig,
      ].sort(),
    );
    assert.ok(
      (await publicRole()).keys.every(
        (key) => key.mode === FILE_MODES.privateFile,
      ),
    );
    await assert.rejects(roleSigner('buyer'), /Cross-role/);
    await roleSigner('owner');
    await assert.rejects(
      setupRole({
        role: 'seller',
        mint: MINT,
        buyer: buyer.address,
        payTo: buyer.address,
      }),
      /preserved/,
    );
  } finally {
    process.chdir(original);
    await rm(directory, { recursive: true, force: true });
  }
});
