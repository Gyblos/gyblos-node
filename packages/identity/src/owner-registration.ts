// Builds seller-funded 8004 registration messages and reports their simulated costs.
// Sending and transaction confirmation are separate operations.
import {
  createSignerFromKeyPair,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { DEVNET_GENESIS } from '@gyblos/config';

import {
  IDENTITY_ERROR_CODES,
  OWNER_REGISTRATION_COMMITMENT,
} from './constants';
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
  asset: KeyPairSigner;
  node: DetachedSigner;
  agentUri: string;
  bindingSequence: bigint;
}
export interface OwnerRegistration {
  message: SponsoredMessage;
  feeLamports: bigint;
  estimatedTotalLamports: bigint;
  nodeId: string;
}
async function estimateOwnerCost(
  rpc: Rpc<SolanaRpcApi>,
  message: SponsoredMessage,
  owner: Address,
): Promise<{ feeLamports: bigint; estimatedTotalLamports: bigint }> {
  const before = await rpc
    .getBalance(owner, { commitment: OWNER_REGISTRATION_COMMITMENT })
    .send();
  const { ownerAfter, contextSlot } = await simulateOwnerAfter(
    rpc,
    message,
    owner,
    {
      commitment: OWNER_REGISTRATION_COMMITMENT,
      replaceRecentBlockhash: false,
    },
  );
  const after = await rpc
    .getBalance(owner, { commitment: OWNER_REGISTRATION_COMMITMENT })
    .send();
  if (
    before.context.slot !== contextSlot ||
    after.context.slot !== contextSlot ||
    before.value !== after.value
  )
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      'Registration state changed during simulation.',
    );
  const feeLamports = await messageFee(rpc, message);
  const estimatedTotalLamports = before.value - ownerAfter;
  if (estimatedTotalLamports < feeLamports)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      'Invalid registration cost.',
    );
  return { feeLamports, estimatedTotalLamports };
}

export async function buildOwnerRegistration(
  input: OwnerRegistrationInput,
): Promise<OwnerRegistration> {
  const rpc = input.rpc;
  const ownerAddress = input.owner.address;
  const ownerKeys = {
    publicKey: input.owner.keyPair.publicKey,
    privateKey: input.owner.keyPair.privateKey,
  };
  const assetAddress = input.asset.address;
  const assetKeys = {
    publicKey: input.asset.keyPair.publicKey,
    privateKey: input.asset.keyPair.privateKey,
  };
  const node = {
    address: input.node.address,
    signDetached: input.node.signDetached.bind(input.node),
  };
  const agentUri = input.agentUri;
  const bindingSequence = input.bindingSequence;
  if ((await rpc.getGenesisHash().send()) !== DEVNET_GENESIS)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.NETWORK_MISMATCH,
      'Registration requires devnet.',
    );
  const deadline = await chainDeadline(rpc, OWNER_REGISTRATION_COMMITMENT);
  const [owner, asset] = await Promise.all([
    createSignerFromKeyPair(ownerKeys),
    createSignerFromKeyPair(assetKeys),
  ]);
  const payoutWallet = await detachedSignerFromKeyPair(ownerKeys);
  if (
    owner.address !== ownerAddress ||
    asset.address !== assetAddress ||
    payoutWallet.address !== ownerAddress
  )
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      'Owner signer mismatch.',
    );
  const { nodeId, instructions } = await registrationInstructions(
    { owner, asset, node, agentUri, bindingSequence, payoutWallet },
    deadline,
  );
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: OWNER_REGISTRATION_COMMITMENT })
    .send();
  const message = composeMessage(owner, blockhash, instructions);
  assertFits(message);
  const cost = await estimateOwnerCost(rpc, message, owner.address);
  return { message, ...cost, nodeId };
}
