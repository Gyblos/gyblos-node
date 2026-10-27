// Owns signed synthetic registry accounts and their disposable loopback RPC for resolution tests.
// No real chain, keys or writes are available to this fixture.
import { nodeIdFromAddress } from '@gyblos/identity/codec';

import { addClaimant, type SyntheticChain } from './identity-accounts.js';
import { fixedSigner } from './identity-fixture.js';
import { startFakeRpc } from './identity-rpc-fake.js';

export async function identityResolutionFixture() {
  const node = await fixedSigner(1);
  const owner = (await fixedSigner(2)).address;
  const asset = (await fixedSigner(3)).address;
  const nextOwner = (await fixedSigner(4)).address;
  const nextAsset = (await fixedSigner(5)).address;
  const chain: SyntheticChain = new Map();
  const accounts = await addClaimant(chain, {
    owner,
    asset,
    node,
    sequence: 5n,
  });
  const fake = await startFakeRpc(chain);
  return {
    ...fake,
    node,
    owner,
    asset,
    nextOwner,
    nextAsset,
    accounts,
    chain,
    nodeId: nodeIdFromAddress(node.address),
  };
}
