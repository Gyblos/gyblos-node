import { parseArgs } from 'node:util';

import { publicRole, setupRole } from './roles.js';

export async function setupP2PRole() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      role: { type: 'string' },
      mint: { type: 'string' },
      buyer: { type: 'string' },
      'pay-to': { type: 'string' },
    },
  });
  if ((values.role !== 'buyer' && values.role !== 'seller') || !values.mint)
    throw new Error(
      'Specify --role buyer|seller and --mint; seller also requires --buyer and --pay-to.',
    );
  await setupRole({
    role: values.role,
    mint: values.mint,
    buyer: values.buyer,
    payTo: values['pay-to'],
  });
  console.log(JSON.stringify(await publicRole()));
}
