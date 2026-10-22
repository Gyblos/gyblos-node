// Owns laboratory sponsored identity flow shared by the integration test and the devnet run:
// policy check → build + simulate → sign → send → read back. Product code must not depend on this module.
import {
  generateKeyPair,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type TransactionSigner,
} from '@solana/kit';

import { COMMITMENT, SVM_TRANSACTION_VERSION } from '@gyblos/config';
import {
  buildSponsoredRegistration,
  decideSponsorship,
  detachedSignerFromKeyPair,
  EMPTY_LEDGER,
  readNodeIdentity,
  resolveOwner,
  type DetachedSigner,
  type NodeIdentity,
  type SponsorDecision,
} from '@gyblos/identity';

const CONFIRM_POLL_MS = 500;
const CONFIRM_ATTEMPTS = 120;
const LAB_POLICY = {
  budgetLamports: 1_000_000_000n,
  maxPerRegistrationLamports: 15_000_000n,
};
const CONFIRMED_STATUSES = new Set(['confirmed', 'finalized']);
const JSON_INDENT = 2;

export interface FlowParticipants {
  owner: TransactionSigner;
  asset: TransactionSigner;
  node: DetachedSigner;
  payoutWallet: DetachedSigner;
}

export interface FlowResult {
  signature: Signature;
  decision: SponsorDecision;
  prefundLamports: bigint;
  feeLamports: bigint;
  sponsorSpentLamports: bigint;
  ownerBalanceAfter: bigint;
  transactionBytes: number;
  unitsConsumed: bigint;
  nodeId: string;
  byAsset: NodeIdentity | undefined;
  byOwner: NodeIdentity[];
  resolvedOwner: Address | undefined;
}

export async function freshParticipants(): Promise<FlowParticipants> {
  return {
    owner: await generateKeyPairSigner(),
    asset: await generateKeyPairSigner(),
    node: await detachedSignerFromKeyPair(await generateKeyPair()),
    payoutWallet: await detachedSignerFromKeyPair(await generateKeyPair()),
  };
}

export async function confirm(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
): Promise<void> {
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
    const [status] = (await rpc.getSignatureStatuses([signature]).send()).value;
    if (status?.err)
      throw new Error(`transaction failed: ${printable(status.err)}`);
    if (CONFIRMED_STATUSES.has(status?.confirmationStatus ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
  }
  throw new Error(`transaction ${signature} not confirmed in time`);
}

async function balance(
  rpc: Rpc<SolanaRpcApi>,
  account: Address,
): Promise<bigint> {
  return (await rpc.getBalance(account, { commitment: COMMITMENT }).send())
    .value;
}

async function sendSponsored(
  rpc: Rpc<SolanaRpcApi>,
  message: Parameters<typeof signTransactionMessageWithSigners>[0],
): Promise<{ signature: Signature; feeLamports: bigint }> {
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      preflightCommitment: COMMITMENT,
    })
    .send();
  await confirm(rpc, signature);
  const transaction = await rpc
    .getTransaction(signature, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: SVM_TRANSACTION_VERSION,
      encoding: 'json',
    })
    .send();
  return { signature, feeLamports: transaction?.meta?.fee ?? 0n };
}

export async function runSponsoredFlow(
  rpc: Rpc<SolanaRpcApi>,
  sponsor: TransactionSigner,
  participants: FlowParticipants,
  agentUri: string,
): Promise<FlowResult> {
  const sponsorBefore = await balance(rpc, sponsor.address);
  const built = await buildSponsoredRegistration({
    rpc,
    sponsor,
    agentUri,
    ...participants,
  });
  const request = {
    deviceKey: built.nodeId,
    owner: participants.owner.address,
    costLamports: built.prefundLamports,
  };
  const decision = await decideSponsorship(
    request,
    EMPTY_LEDGER,
    LAB_POLICY,
    async () => true,
  );
  if (!decision.allow)
    throw new Error(`sponsorship denied: ${decision.reason}`);
  const sent = await sendSponsored(rpc, built.message);
  return {
    ...sent,
    decision,
    prefundLamports: built.prefundLamports,
    sponsorSpentLamports: sponsorBefore - (await balance(rpc, sponsor.address)),
    ownerBalanceAfter: await balance(rpc, participants.owner.address),
    transactionBytes: built.transactionBytes,
    unitsConsumed: built.unitsConsumed,
    nodeId: built.nodeId,
    byAsset: await readNodeIdentity(rpc, { asset: participants.asset.address }),
    byOwner: await readNodeIdentity(rpc, { owner: participants.owner.address }),
    resolvedOwner: await resolveOwner(rpc, built.nodeId),
  };
}

export function printable(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    JSON_INDENT,
  );
}
