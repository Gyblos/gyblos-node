// Builds seller-funded 8004 registration messages and reports their simulated costs.
// Sending and transaction confirmation are separate operations.
import type {
  KeyPairSigner,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from '@solana/kit';

import { COMMITMENT, DEVNET_GENESIS } from '@gyblos/config';

import { IDENTITY_ERROR_CODES } from './constants';
import { IdentityError } from './errors';
import {
  assertFits,
  chainDeadline,
  composeMessage,
  messageFee,
  registrationInstructions,
  simulateOwnerAfter,
  type SponsoredMessage,
} from './registration';
import { detachedSignerFromKeyPair, type DetachedSigner } from './signers';

export interface OwnerRegistrationInput {
  rpc: Rpc<SolanaRpcApi>;
  owner: KeyPairSigner;
  asset: TransactionSigner;
  node: DetachedSigner;
  agentUri: string;
  bindingSequence: bigint;
}
export interface OwnerRegistration {
  message: SponsoredMessage;
  feeLamports: bigint;
  totalLamports: bigint;
  nodeId: string;
}
export async function buildOwnerRegistration(
  input: OwnerRegistrationInput,
): Promise<OwnerRegistration> {
  if ((await input.rpc.getGenesisHash().send()) !== DEVNET_GENESIS)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.NETWORK_MISMATCH,
      'Registration requires devnet.',
    );
  const deadline = await chainDeadline(input.rpc);
  const payoutWallet = await detachedSignerFromKeyPair(input.owner.keyPair);
  if (payoutWallet.address !== input.owner.address)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      'Owner signer mismatch.',
    );
  const { nodeId, instructions } = await registrationInstructions(
    { ...input, payoutWallet },
    deadline,
  );
  const { value: blockhash } = await input.rpc
    .getLatestBlockhash({ commitment: COMMITMENT })
    .send();
  const message = composeMessage(input.owner, blockhash, instructions);
  assertFits(message);
  const before = (
    await input.rpc
      .getBalance(input.owner.address, { commitment: COMMITMENT })
      .send()
  ).value;
  const { ownerAfter } = await simulateOwnerAfter(
    input.rpc,
    message,
    input.owner.address,
  );
  const feeLamports = await messageFee(input.rpc, message);
  const totalLamports = before - ownerAfter;
  if (totalLamports < feeLamports)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      'Invalid registration cost.',
    );
  return {
    message,
    feeLamports,
    totalLamports,
    nodeId,
  };
}
