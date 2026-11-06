// Prompts before submitting the seller-funded 8004 registration.
// Private keys and transaction bytes remain inside the node registration service.
import {
  registerSellerIdentity,
  sellerRegistrationOperations,
} from '@gyblos/node/seller-registration';

import type { Prompt } from './cli-init';
import { REGISTER } from './constants';
import {
  homeEnvironmentOf,
  type sellerIdentity,
  type SellerOutput,
} from './seller-home';

export async function registerOnChain(
  output: SellerOutput,
  identity: NonNullable<Awaited<ReturnType<typeof sellerIdentity>>>,
  prompt: Prompt,
) {
  const environment = homeEnvironmentOf(output);
  return registerSellerIdentity({
    environment,
    identity: { owner: identity.owner, nodeId: identity.nodeId },
    operations: sellerRegistrationOperations({ environment, role: identity }),
    onCostChanged: () =>
      output.stderr(
        'Registration cost increased; run the command again to review the updated estimate.\n',
      ),
    confirm: async (lamports) => {
      const whole = lamports / REGISTER.lamportsPerSol;
      const fraction = String(lamports % REGISTER.lamportsPerSol).padStart(
        REGISTER.solDecimals,
        '0',
      );
      output.stdout(`Estimated registration cost: ${whole}.${fraction} SOL.\n`);
      return (
        (await prompt('Sign and submit this registration? (yes/no): '))
          .trim()
          .toLowerCase() === 'yes'
      );
    },
  });
}
