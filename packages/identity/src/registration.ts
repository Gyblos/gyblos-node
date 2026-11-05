// Owns the sponsored registration flow: one atomic message (prefund, register, nodeId binding, payout wallet),
// the simulations that size and then check the prefund, and the sponsor's cost ceiling. Must not know policy,
// keys or sending.
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionMessageBytesBase64,
  type TransactionSigner,
} from '@solana/kit';

import { COMMITMENT, SVM_TRANSACTION_VERSION } from '@gyblos/config';

import { encodeBindingValue, signNodeBinding } from './binding';
import {
  BASE64_ENCODING,
  IDENTITY_ERROR_CODES,
  LIMITS,
  METADATA_KEYS,
  REGISTRATION_DEFAULTS,
} from './constants';
import { IdentityError } from './errors';
import {
  prefundInstruction,
  registerInstruction,
  setAgentWalletInstructions,
  setMetadataInstruction,
} from './instructions';
import type { DetachedSigner } from './signers';

const BASE64_BITS_PER_CHAR = 6;
const BITS_PER_BYTE = 8;
const SIMULATION_LOG_TAIL = 3;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;
// Kit's base64 "decoder" turns message bytes into base64 text.
const BYTES_TO_BASE64_TEXT = getBase64Decoder();

type IdentityRpc = Rpc<SolanaRpcApi>;

export interface SponsoredRegistrationInput {
  rpc: IdentityRpc;
  sponsor: TransactionSigner;
  owner: TransactionSigner;
  asset: TransactionSigner;
  node: DetachedSigner;
  payoutWallet: DetachedSigner;
  agentUri: string;
  // Rebinding sequence the node key signs; the highest valid sequence for a NodeId wins resolveOwner.
  // Use a strictly increasing value per node key (unix ms, or a counter persisted with the key).
  bindingSequence: bigint;
  // Ceiling on prefund + fee; a larger computed cost throws SPONSOR_COST_ABOVE_CEILING.
  maxSponsorCostLamports: bigint;
  probeLamports?: bigint;
}

export type SponsoredMessage = ReturnType<typeof composeMessage>;

export interface SponsoredRegistration {
  message: SponsoredMessage;
  prefundLamports: bigint;
  feeLamports: bigint;
  // Everything the sponsor pays: prefund + fee. Budget and ledger accounting use this value.
  sponsorCostLamports: bigint;
  unitsConsumed: bigint;
  transactionBytes: number;
  nodeId: string;
}

export interface OwnerSpend {
  spentLamports: bigint;
  ownerBalance: bigint;
  unitsConsumed: bigint;
}

type Blockhash = Awaited<
  ReturnType<ReturnType<IdentityRpc['getLatestBlockhash']>['send']>
>['value'];

export function composeMessage(
  feePayer: TransactionSigner,
  blockhash: Blockhash,
  instructions: readonly Instruction[],
) {
  return pipe(
    createTransactionMessage({ version: SVM_TRANSACTION_VERSION }),
    (message) => setTransactionMessageFeePayerSigner(feePayer, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
    (message) => appendTransactionMessageInstructions(instructions, message),
  );
}

function wireBase64(message: SponsoredMessage) {
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

function wireBytes(base64: string): number {
  const padding = (base64.match(/=+$/)?.[0] ?? '').length;
  return (base64.length * BASE64_BITS_PER_CHAR) / BITS_PER_BYTE - padding;
}

export async function chainDeadline(rpc: IdentityRpc): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: COMMITMENT }).send();
  const blockTime = await rpc.getBlockTime(slot).send();
  if (blockTime === null) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      `no block time for slot ${slot}`,
    );
  }
  return BigInt(blockTime) + REGISTRATION_DEFAULTS.walletDeadlineSeconds;
}

export async function registrationInstructions(
  input: Pick<
    SponsoredRegistrationInput,
    'owner' | 'asset' | 'node' | 'payoutWallet' | 'agentUri' | 'bindingSequence'
  >,
  deadline: bigint,
) {
  const binding = await signNodeBinding(input.node, {
    asset: input.asset.address,
    owner: input.owner.address,
    sequence: input.bindingSequence,
  });
  const register = await registerInstruction(
    input.owner,
    input.asset,
    input.agentUri,
  );
  const metadata = await setMetadataInstruction(
    input.owner,
    input.asset.address,
    METADATA_KEYS.nodeId,
    encodeBindingValue(binding),
  );
  const wallet = await setAgentWalletInstructions(
    input.owner,
    input.asset.address,
    input.payoutWallet,
    deadline,
  );
  return {
    nodeId: binding.nodeId,
    instructions: [register, metadata, ...wallet],
  };
}

function simulationDetail(
  err: unknown,
  logs: readonly string[] | null,
): string {
  const detail = JSON.stringify(err, (_key, item: unknown) =>
    typeof item === 'bigint' ? String(item) : item,
  );
  return `simulation failed: ${detail}; ${(logs ?? []).slice(-SIMULATION_LOG_TAIL).join(' | ')}`;
}

// Simulates the message and returns the owner's post-run lamports; any program error throws SIMULATION_FAILED.
export async function simulateOwnerAfter(
  rpc: IdentityRpc,
  message: SponsoredMessage,
  owner: Address,
): Promise<{ ownerAfter: bigint; unitsConsumed: bigint }> {
  const result = await rpc
    .simulateTransaction(wireBase64(message), {
      encoding: BASE64_ENCODING,
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: COMMITMENT,
      accounts: { addresses: [owner], encoding: BASE64_ENCODING },
    })
    .send();
  const ownerAfter = result.value.accounts?.[0]?.lamports;
  if (result.value.err !== null || ownerAfter === undefined) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      simulationDetail(result.value.err, result.value.logs),
    );
  }
  return { ownerAfter, unitsConsumed: result.value.unitsConsumed ?? 0n };
}

// Simulates with a generous prefund and returns how many lamports the owner actually spent.
export async function simulateOwnerSpend(
  rpc: IdentityRpc,
  message: SponsoredMessage,
  owner: Address,
  probeLamports: bigint,
): Promise<OwnerSpend> {
  const before = (
    await rpc.getBalance(owner, { commitment: COMMITMENT }).send()
  ).value;
  const { ownerAfter, unitsConsumed } = await simulateOwnerAfter(
    rpc,
    message,
    owner,
  );
  return {
    spentLamports: before + probeLamports - ownerAfter,
    ownerBalance: before,
    unitsConsumed,
  };
}

// Prefund is exactly the owner's shortfall during the probe run; an owner that can pay gets 0.
export function prefundFromSpend(spend: OwnerSpend): bigint {
  const shortfall = spend.spentLamports - spend.ownerBalance;
  return shortfall > 0n ? shortfall : 0n;
}

function isMessageBase64(text: string): text is TransactionMessageBytesBase64 {
  return BASE64_ALPHABET.test(text);
}

// The network fee for this exact message (signatures plus Ed25519 precompile proofs).
export async function messageFee(
  rpc: IdentityRpc,
  message: SponsoredMessage,
): Promise<bigint> {
  const encoded = BYTES_TO_BASE64_TEXT.decode(
    compileTransaction(message).messageBytes,
  );
  if (!isMessageBase64(encoded)) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ENCODING_INVARIANT,
      'base64 encoder produced invalid output',
    );
  }
  const { value } = await rpc
    .getFeeForMessage(encoded, { commitment: COMMITMENT })
    .send();
  if (value === null) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.FEE_UNAVAILABLE,
      'RPC returned no fee for the registration message',
    );
  }
  return value;
}

function assertWithinCeiling(sponsorCost: bigint, ceiling: bigint): void {
  if (sponsorCost > ceiling) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SPONSOR_COST_ABOVE_CEILING,
      `sponsor cost ${sponsorCost} exceeds ceiling ${ceiling}`,
    );
  }
}

export function assertFits(message: SponsoredMessage): number {
  const transactionBytes = wireBytes(wireBase64(message));
  if (transactionBytes > LIMITS.transactionBytes) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.TRANSACTION_TOO_LARGE,
      `transaction is ${transactionBytes} bytes`,
    );
  }
  return transactionBytes;
}

export async function buildSponsoredRegistration(
  input: SponsoredRegistrationInput,
): Promise<SponsoredRegistration> {
  const probe = input.probeLamports ?? REGISTRATION_DEFAULTS.probeLamports;
  const deadline = await chainDeadline(input.rpc);
  const { nodeId, instructions } = await registrationInstructions(
    input,
    deadline,
  );
  const { value: blockhash } = await input.rpc
    .getLatestBlockhash({ commitment: COMMITMENT })
    .send();
  const withPrefund = (lamports: bigint) =>
    composeMessage(input.sponsor, blockhash, [
      prefundInstruction(input.sponsor, input.owner.address, lamports),
      ...instructions,
    ]);
  const probeRun = await simulateOwnerSpend(
    input.rpc,
    withPrefund(probe),
    input.owner.address,
    probe,
  );
  const prefundLamports = prefundFromSpend(probeRun);
  const message = withPrefund(prefundLamports);
  const transactionBytes = assertFits(message);
  // The final prefund can differ from the probe's (0 for an owner who can pay), so the exact message
  // is simulated once more; an under-funded or rent-violating result throws SIMULATION_FAILED here.
  await simulateOwnerAfter(input.rpc, message, input.owner.address);
  const feeLamports = await messageFee(input.rpc, message);
  const sponsorCostLamports = prefundLamports + feeLamports;
  assertWithinCeiling(sponsorCostLamports, input.maxSponsorCostLamports);
  return {
    message,
    prefundLamports,
    feeLamports,
    sponsorCostLamports,
    unitsConsumed: probeRun.unitsConsumed,
    transactionBytes,
    nodeId,
  };
}
