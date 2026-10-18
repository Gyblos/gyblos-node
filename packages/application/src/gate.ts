import { GateError } from '../../payments-x402/src/chain.js';

export interface Snapshot { buyer: string; seller: string; buyerLamports: string }
export interface GateReceipt {
  authorized: string;
  actual: string;
  openTransaction: string;
  claimTransaction: string;
  channelId: string;
  channelDistributed: boolean;
}

export function verifyAccounting(before: Snapshot, after: Snapshot, receipt: GateReceipt) {
  const ceiling = BigInt(receipt.authorized);
  const actual = BigInt(receipt.actual);
  if (actual <= 0n || actual >= ceiling) throw new GateError('BAD_USAGE', 'Gate must demonstrate a nonzero charge below the ceiling.');
  if (BigInt(before.buyer) - BigInt(after.buyer) !== actual) throw new GateError('BUYER_DELTA', 'Buyer token delta does not match charge.');
  if (BigInt(after.seller) - BigInt(before.seller) !== actual) throw new GateError('SELLER_DELTA', 'Seller token delta does not match charge.');
  if (before.buyerLamports !== after.buyerLamports) throw new GateError('BUYER_GAS', 'Buyer SOL changed during the call.');
  if (!receipt.openTransaction || !receipt.claimTransaction || receipt.openTransaction === receipt.claimTransaction) throw new GateError('MISSING_TRANSACTIONS', 'Distinct open and claim transactions are required.');
  if (!receipt.channelDistributed) throw new GateError('CHANNEL_NOT_DISTRIBUTED', 'Channel still holds undistributed funds.');
  return { ...receipt, refund: (ceiling - actual).toString(), before, after };
}

export interface GateDependencies {
  preflight(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  request(): Promise<{ receipt: GateReceipt; resource: unknown }>;
}

// No console, filesystem, environment or process lifecycle in the application flow.
export async function runGate(deps: GateDependencies) {
  await deps.preflight();
  const before = await deps.snapshot();
  const result = await deps.request();
  const after = await deps.snapshot();
  return { accounting: verifyAccounting(before, after, result.receipt), resource: result.resource };
}
