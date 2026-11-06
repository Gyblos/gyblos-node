// CLI for isolated P2P role provisioning; it does not contact RPC, fund wallets or start the node.
// A seller needs only --mint to sell for free; paid setup defaults payout to the owner.
import { parseArgs } from 'node:util';

import { isSolanaAddress } from '@gyblos/node/configuration';
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
  // Names the flag instead of the Solana library's error, before anything is written.
  for (const [flag, value] of [
    ['--mint', values.mint],
    ['--pay-to', values['pay-to']],
    ['--buyer', values.buyer],
  ] as const)
    if (value !== undefined && !isSolanaAddress(value))
      throw new Error(`${flag} is not a valid Solana address.`);
  await setupRole({
    role: values.role,
    mint: values.mint,
    buyer: values.buyer,
    payTo: values['pay-to'],
  });
  console.log(JSON.stringify(await publicRole(values.role)));
}

if (isMain(import.meta.url)) await main();
