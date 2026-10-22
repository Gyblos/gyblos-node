// Owns the sponsored registration flow: one atomic message (prefund, register, nodeId binding, payout wallet)
// and the simulation that sizes the prefund exactly. Must not know about policy, key storage or sending.
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from '@solana/kit';

import { COMMITMENT, SVM_TRANSACTION_VERSION } from '@gyblos/config';

import { encodeBindingValue, signNodeBinding } from './binding.js';
import {
  IDENTITY_ERROR_CODES,
  LIMITS,
  METADATA_KEYS,
  REGISTRATION_DEFAULTS,
} from './constants.js';
import { IdentityError } from './errors.js';
import {
  prefundInstruction,
  registerInstruction,
  setAgentWalletInstructions,
  setMetadataInstruction,
} from './instructions.js';
import type { DetachedSigner } from './signers.js';

const BASE64_BITS_PER_CHAR = 6;
const BITS_PER_BYTE = 8;
const SIMULATION_LOG_TAIL = 3;
const BASE64_ENCODING = 'base64' as const;

type IdentityRpc = Rpc<SolanaRpcApi>;

export interface SponsoredRegistrationInput {
  rpc: IdentityRpc;
  sponsor: TransactionSigner;
  owner: TransactionSigner;
  asset: TransactionSigner;
  node: DetachedSigner;
  payoutWallet: DetachedSigner;
  agentUri: string;
  probeLamports?: bigint;
}

export type SponsoredMessage = ReturnType<typeof composeMessage>;

export interface SponsoredRegistration {
  message: SponsoredMessage;
  prefundLamports: bigint;
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

function composeMessage(
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

async function chainDeadline(rpc: IdentityRpc): Promise<bigint> {
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

async function registrationInstructions(
  input: SponsoredRegistrationInput,
  deadline: bigint,
) {
  const binding = await signNodeBinding(
    input.node,
    input.asset.address,
    input.owner.address,
  );
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
  const result = await rpc
    .simulateTransaction(wireBase64(message), {
      encoding: BASE64_ENCODING,
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: COMMITMENT,
      accounts: { addresses: [owner], encoding: BASE64_ENCODING },
    })
    .send();
  const after = result.value.accounts?.[0]?.lamports;
  if (result.value.err !== null || after === undefined) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.SIMULATION_FAILED,
      simulationDetail(result.value.err, result.value.logs),
    );
  }
  return {
    spentLamports: before + probeLamports - after,
    ownerBalance: before,
    unitsConsumed: result.value.unitsConsumed ?? 0n,
  };
}

// Prefund is exactly the owner's shortfall during the probe run; an owner that can pay gets 0.
export function prefundFromSpend(spend: OwnerSpend): bigint {
  const shortfall = spend.spentLamports - spend.ownerBalance;
  return shortfall > 0n ? shortfall : 0n;
}

function assertFits(message: SponsoredMessage): number {
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
  return {
    message,
    prefundLamports,
    unitsConsumed: probeRun.unitsConsumed,
    transactionBytes,
    nodeId,
  };
}
