// CLI for isolated P2P role provisioning; it does not contact RPC, fund wallets or start the node.
// A seller needs only --mint to sell for free.
import { parseArgs } from 'node:util';

import { publicRole, setupRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      role: { type: 'string' },
      mint: { type: 'string' },
      buyer: { type: 'string' },
      'pay-to': { type: 'string' },
    },
  });
  if (
    (values.role !== P2P_ROLES.BUYER && values.role !== P2P_ROLES.SELLER) ||
    !values.mint
  )
    throw new Error(
      'Specify --role buyer|seller and --mint; a free seller needs nothing else.',
    );
  // Paid selling is off; its keys are made only when both paid flags are given.
  if (
    values.role === P2P_ROLES.SELLER &&
    (values.buyer === undefined) !== (values['pay-to'] === undefined)
  )
    throw new Error('Paid seller keys need --buyer and --pay-to together.');
  await setupRole({
    role: values.role,
    mint: values.mint,
    buyer: values.buyer,
    payTo: values['pay-to'],
  });
  console.log(JSON.stringify(await publicRole(values.role)));
}

if (isMain(import.meta.url)) await main();
