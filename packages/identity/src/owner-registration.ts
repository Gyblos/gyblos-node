// Builds seller-funded 8004 registration messages and reports their simulated costs.
// Sending and transaction confirmation are separate operations.
import {
  createSignerFromKeyPair,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { DEVNET_GENESIS, FINALIZED_COMMITMENT } from '@gyblos/config';

import {
  IDENTITY_ERROR_CODES,
  IDENTITY_RESOLUTION_LIMITS,
  REGISTRATION_ERROR_LIMITS,
} from './constants';
import { IdentityError } from './errors';
import { estimateOwnerFunding } from './owner-cost';
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
  timeoutMs?: number;
  onEstimate?: (lamports: bigint) => void;
}
export interface OwnerRegistration {
  message: SponsoredMessage;
  feeLamports: bigint;
  estimatedTotalLamports: bigint;
  nodeId: string;
  lastValidBlockHeight: bigint;
}
async function estimateOwnerCost(
  rpc: Rpc<SolanaRpcApi>,
  message: SponsoredMessage,
  owner: Address,
  signal: AbortSignal,
  minimum: bigint,
): Promise<{ feeLamports: bigint; estimatedTotalLamports: bigint }> {
  const before = await rpc
    .getBalance(owner, { commitment: FINALIZED_COMMITMENT })
    .send({ abortSignal: signal });
  const { ownerAfter, contextSlot } = await simulateOwnerAfter(
    rpc,
    message,
    owner,
    {
      commitment: FINALIZED_COMMITMENT,
      replaceRecentBlockhash: false,
      signal,
    },
  );
  const after = await rpc
    .getBalance(owner, { commitment: FINALIZED_COMMITMENT })
    .send({ abortSignal: signal });
  if (
    before.context.slot !== contextSlot ||
    after.context.slot !== contextSlot ||
    before.value !== after.value
  )
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      'Registration state changed during simulation.',
    );
  const feeLamports = await messageFee(rpc, message, signal);
  const estimatedTotalLamports = before.value - ownerAfter;
  if (estimatedTotalLamports < feeLamports)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      'Invalid registration cost.',
    );
  return {
    feeLamports,
    estimatedTotalLamports:
      estimatedTotalLamports > minimum ? estimatedTotalLamports : minimum,
  };
}

function assertInstructionCount(count: number): void {
  if (BigInt(count) !== REGISTRATION_ERROR_LIMITS.maxInstructionIndex + 1n)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ENCODING_INVARIANT,
      'Unexpected registration instruction count.',
    );
}
async function buildWithinDeadline(
  input: OwnerRegistrationInput,
  signal: AbortSignal,
): Promise<OwnerRegistration> {
  const rpc = input.rpc;
  const onEstimate = input.onEstimate;
  const ownerAddress = input.owner.address;
  const ownerKeys = { ...input.owner.keyPair };
  const assetAddress = input.asset.address;
  const assetKeys = { ...input.asset.keyPair };
  const node = {
    address: input.node.address,
    signDetached: input.node.signDetached.bind(input.node),
  };
  const agentUri = input.agentUri;
  const bindingSequence = input.bindingSequence;
  if (
    (await rpc.getGenesisHash().send({ abortSignal: signal })) !==
    DEVNET_GENESIS
  )
    throw new IdentityError(
      IDENTITY_ERROR_CODES.NETWORK_MISMATCH,
      'Registration requires devnet.',
    );
  signal.throwIfAborted();
  const deadline = await chainDeadline(rpc, FINALIZED_COMMITMENT, signal);
  signal.throwIfAborted();
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
  signal.throwIfAborted();
  const { nodeId, instructions } = await registrationInstructions(
    { owner, asset, node, agentUri, bindingSequence, payoutWallet },
    deadline,
  );
  assertInstructionCount(instructions.length);
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: FINALIZED_COMMITMENT })
    .send({ abortSignal: signal });
  signal.throwIfAborted();
  const message = composeMessage(owner, blockhash, instructions);
  assertFits(message);
  const preliminary = await estimateOwnerFunding(
    rpc,
    message,
    owner.address,
    agentUri,
    signal,
    onEstimate,
  );
  const cost = await estimateOwnerCost(
    rpc,
    message,
    owner.address,
    signal,
    preliminary.estimatedTotalLamports,
  );
  signal.throwIfAborted();
  return {
    message,
    ...cost,
    nodeId,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  };
}

export async function buildOwnerRegistration(
  input: OwnerRegistrationInput,
): Promise<OwnerRegistration> {
  const timeoutMs = input.timeoutMs ?? IDENTITY_RESOLUTION_LIMITS.timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > IDENTITY_RESOLUTION_LIMITS.maxTimeoutMs
  )
    throw new IdentityError(
      IDENTITY_ERROR_CODES.INPUT_INVALID,
      'Invalid registration timeout.',
    );
  const signal = AbortSignal.timeout(timeoutMs);
  let onAbort = () => {};
  try {
    return await Promise.race([
      buildWithinDeadline(input, signal),
      new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(
            new IdentityError(
              IDENTITY_ERROR_CODES.READ_TIMEOUT,
              'Registration RPC deadline elapsed.',
            ),
          );
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } catch (error) {
    if (signal.aborted)
      throw new IdentityError(
        IDENTITY_ERROR_CODES.READ_TIMEOUT,
        'Registration RPC deadline elapsed.',
      );
    if (
      error instanceof IdentityError &&
      error.code === IDENTITY_ERROR_CODES.SIMULATION_FAILED
    )
      throw new IdentityError(
        IDENTITY_ERROR_CODES.SIMULATION_FAILED,
        'Registration simulation failed.',
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
