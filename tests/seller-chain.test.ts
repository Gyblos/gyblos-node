// The daemon's devnet payment server is built from the seller role: its payout, fee payer and authorizer
// keys, the network fee and the role's private payments directory. Ephemeral role files in a temporary
// home; the RPC is never called.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { DEVNET, PROTOCOL_FEE } from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { loadRole, setupRole } from '@gyblos/node/roles';
import { sellerChainPayments } from '@gyblos/node/seller-chain';
import { P2P_ROLES } from '@gyblos/protocol/constants';

async function withHome(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-seller-chain-'));
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = home;
  try {
    await run(home);
  } finally {
    if (previous === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

const address = async () => (await generateKeyPairSigner()).address;

void test('a seller set up with a payout gets a payment server for its own keys and fee', () =>
  withHome(async (home) => {
    const payTo = await address();
    await setupRole({
      role: P2P_ROLES.SELLER,
      mint: await address(),
      payTo,
      buyer: await address(),
    });
    const role = await loadRole(P2P_ROLES.SELLER);
    assert.ok(role.role === P2P_ROLES.SELLER && role.facilitator);
    const payments = await sellerChainPayments({ GYBLOS_HOME: home })(role);
    try {
      assert.deepEqual(await payments.server.describe(), {
        network: DEVNET,
        mint: role.mint,
        payTo,
        feePayer: role.facilitator,
        authorizer: role.authorizer,
        protocolFeeBps: PROTOCOL_FEE.bps,
        treasury: PROTOCOL_FEE.treasury,
      });
    } finally {
      await payments.close();
    }
  }));

void test('a seller set up without a payout cannot sell paid', () =>
  withHome(async (home) => {
    await setupRole({ role: P2P_ROLES.SELLER, mint: await address() });
    const role = await loadRole(P2P_ROLES.SELLER);
    await assert.rejects(
      sellerChainPayments({ GYBLOS_HOME: home })(role),
      (error) =>
        error instanceof NodeError &&
        error.code === NODE_ERROR_CODES.SELLER_PAYMENT_ROLE_MISSING,
    );
  }));
