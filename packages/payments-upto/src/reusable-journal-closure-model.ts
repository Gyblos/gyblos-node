// Verifies a signed finalized closure record before accepting it from disk.
import { isAddress } from '@solana/kit';
import { uptoTokenAccount } from 'x402-upto-metered';

import { settlementShares } from '@gyblos/protocol/payment-binding';

import { REUSABLE_JOURNAL, REUSABLE_JOURNAL_STATES } from './constants';
import { verifyClosure } from './reusable-journal-crypto';
import type {
  ReusableChannelTerms,
  ReusableClosureRecord,
  ReusablePending,
  ReusableVoucher,
} from './reusable-journal-types';
import { atomic, fields, unavailable } from './reusable-journal-validation';

export function closureRedirected(
  terms: ReusableChannelTerms,
  authorizedAtomic: string,
  hold: ReusablePending | null,
  vouchers: ReusableVoucher[],
  closure: Omit<ReusableClosureRecord, 'signature'>,
): boolean {
  const amount = BigInt(closure.settledAtomic);
  const shares = settlementShares(closure.settledAtomic, terms.protocolFeeBps);
  const redirected =
    BigInt(closure.buyerRefundRedirectedAtomic) +
    BigInt(closure.sellerRedirectedAtomic) +
    BigInt(closure.treasuryRedirectedAtomic);
  if (
    amount > BigInt(authorizedAtomic) ||
    (amount !== 0n &&
      !vouchers.some(
        (item) => item.maxClaimableAmount === closure.settledAtomic,
      ) &&
      hold?.maxClaimableAmount !== closure.settledAtomic) ||
    BigInt(closure.sellerReceivedAtomic) +
      BigInt(closure.sellerRedirectedAtomic) !==
      BigInt(shares.sellerAtomic) ||
    BigInt(closure.treasuryReceivedAtomic) +
      BigInt(closure.treasuryRedirectedAtomic) !==
      BigInt(shares.feeAtomic) ||
    BigInt(closure.sellerReceivedAtomic) +
      BigInt(closure.treasuryReceivedAtomic) +
      BigInt(closure.sellerRedirectedAtomic) +
      BigInt(closure.treasuryRedirectedAtomic) +
      BigInt(closure.programResidualAtomic) !==
      amount ||
    amount +
      BigInt(closure.buyerRefundAtomic) +
      BigInt(closure.buyerRefundRedirectedAtomic) !==
      BigInt(terms.depositAtomic)
  )
    unavailable();
  return redirected !== 0n;
}

export async function parseClosure(
  raw: Record<string, unknown>,
  terms: ReusableChannelTerms,
  authorizedAtomic: string,
  hold: ReusablePending | null,
  vouchers: ReusableVoucher[],
): Promise<ReusableClosureRecord | null> {
  if (
    raw.status !== REUSABLE_JOURNAL_STATES.CLOSED &&
    raw.status !== REUSABLE_JOURNAL_STATES.CLOSED_REDIRECTED
  ) {
    if (raw.closure !== null) unavailable();
    return null;
  }
  if (
    !fields(raw.closure, [
      'contextSlot',
      'escrowTokenAccount',
      'programTreasuryOwner',
      'settledAtomic',
      'sellerReceivedAtomic',
      'treasuryReceivedAtomic',
      'programResidualAtomic',
      'buyerRefundAtomic',
      'buyerRefundRedirectedAtomic',
      'sellerRedirectedAtomic',
      'treasuryRedirectedAtomic',
      'signature',
    ]) ||
    typeof raw.closure.signature !== 'string' ||
    typeof raw.closure.escrowTokenAccount !== 'string' ||
    typeof raw.closure.programTreasuryOwner !== 'string' ||
    !isAddress(raw.closure.programTreasuryOwner) ||
    raw.closure.signature.length > REUSABLE_JOURNAL.signatureChars
  )
    unavailable();
  const closure = {
    contextSlot: atomic(raw.closure.contextSlot),
    escrowTokenAccount: raw.closure.escrowTokenAccount,
    programTreasuryOwner: raw.closure.programTreasuryOwner,
    settledAtomic: atomic(raw.closure.settledAtomic),
    sellerReceivedAtomic: atomic(raw.closure.sellerReceivedAtomic),
    treasuryReceivedAtomic: atomic(raw.closure.treasuryReceivedAtomic),
    programResidualAtomic: atomic(raw.closure.programResidualAtomic),
    buyerRefundAtomic: atomic(raw.closure.buyerRefundAtomic),
    buyerRefundRedirectedAtomic: atomic(
      raw.closure.buyerRefundRedirectedAtomic,
    ),
    sellerRedirectedAtomic: atomic(raw.closure.sellerRedirectedAtomic),
    treasuryRedirectedAtomic: atomic(raw.closure.treasuryRedirectedAtomic),
    signature: raw.closure.signature,
  };
  const redirected = closureRedirected(
    terms,
    authorizedAtomic,
    hold,
    vouchers,
    closure,
  );
  if (
    closure.escrowTokenAccount !==
      (await uptoTokenAccount(
        terms.channelId,
        terms.mint,
        terms.tokenProgram,
      )) ||
    closure.contextSlot !== atomic(raw.lastObservedSlot) ||
    BigInt(closure.contextSlot) < BigInt(terms.openSlot) ||
    (raw.status === REUSABLE_JOURNAL_STATES.CLOSED_REDIRECTED) !== redirected ||
    !(await verifyClosure(terms, closure))
  )
    unavailable();
  return closure;
}
