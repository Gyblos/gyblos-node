// CLI for isolated P2P role provisioning; it does not contact RPC, fund wallets or start the node.
import { parseArgs } from 'node:util';

import { P2P_ROLES } from '@gyblos/node/constants';
import { publicRole, setupRole } from '@gyblos/node/roles';
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
      'Specify --role buyer|seller and --mint; seller also requires --buyer and --pay-to.',
    );
  await setupRole({
    role: values.role,
    mint: values.mint,
    buyer: values.buyer,
    payTo: values['pay-to'],
  });
  console.log(JSON.stringify(await publicRole(values.role)));
}

if (isMain(import.meta.url)) await main();
