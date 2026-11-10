// CLI for isolated P2P role provisioning; it does not contact RPC, fund wallets or start the node.
// A seller needs only --mint: it gets owner, node and payment keys, paid to its owner, so any offer can be
// free or priced. Rerunning it on a seller without payment keys adds them.
import { parseArgs } from 'node:util';

import { isSolanaAddress } from '@gyblos/node/configuration';
import { publicRole, setupRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      role: { type: 'string' },
      mint: { type: 'string' },
      // Earlier releases' paid seller setup; refused with an explanation.
      buyer: { type: 'string' },
      'pay-to': { type: 'string' },
    },
  });
  if (values.buyer !== undefined || values['pay-to'] !== undefined)
    throw new Error(
      '--buyer and --pay-to are no longer used: every seller gets its payment keys, paid to its owner.',
    );
  if (
    (values.role !== P2P_ROLES.BUYER && values.role !== P2P_ROLES.SELLER) ||
    !values.mint
  )
    throw new Error(
      'Specify --role buyer|seller and --mint; nothing else is needed.',
    );
  // Names the flag instead of the Solana library's error, before anything is written.
  if (!isSolanaAddress(values.mint))
    throw new Error('--mint is not a valid Solana address.');
  await setupRole({ role: values.role, mint: values.mint });
  console.log(JSON.stringify(await publicRole(values.role)));
}
