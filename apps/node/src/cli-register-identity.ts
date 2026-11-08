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

// The operator answered no: nothing was signed or sent.
export class RegistrationDeclined extends Error {}

const ACCEPT = new Set(['y', 'yes']);
// y or yes, any case or surrounding space; anything else, including an empty answer, declines.
export const approves = (answer: string) =>
  ACCEPT.has(answer.trim().toLowerCase());

export async function registerOnChain(
  output: SellerOutput,
  identity: NonNullable<Awaited<ReturnType<typeof sellerIdentity>>>,
  prompt: Prompt,
) {
  const environment = homeEnvironmentOf(output);
  let declined = false;
  const ready = await registerSellerIdentity({
    environment,
    identity: { owner: identity.owner, nodeId: identity.nodeId },
    operations: sellerRegistrationOperations({ environment, role: identity }),
    onEstimate: (lamports) =>
      output.stdout(
        `Pre-simulation funding estimate: ${registrationSol(lamports)} SOL; the cost may change.\n`,
      ),
    onResend: () =>
      output.stdout('Resending the previously approved registration.\n'),
    onCostChanged: () =>
      output.stderr(
        'Registration cost increased; run the command again to review the updated estimate.\n',
      ),
    confirm: async (lamports) => {
      output.stdout(
        `Estimated registration cost: ${registrationSol(lamports)} SOL.\n`,
      );
      declined = !approves(
        await prompt('Sign and submit this registration? (yes/no): '),
      );
      return !declined;
    },
  });
  if (declined) throw new RegistrationDeclined();
  return ready;
}

// Amounts come from bounded registration arithmetic, never user-formatted decimal text.
export function registrationSol(lamports: bigint): string {
  return `${lamports / REGISTER.lamportsPerSol}.${String(lamports % REGISTER.lamportsPerSol).padStart(REGISTER.solDecimals, '0')}`;
}
