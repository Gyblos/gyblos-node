// One canonical SDK deposit builder, shared by signing and offline recovery message reconstruction.
import { blockhash } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@x402/svm';
import { buildDepositPayload } from '@x402/svm/batch-settlement/client';

import { paymentSplits } from '@gyblos/protocol/payment-binding';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { requirementsFor } from './batch-session-checks';
import type { BatchBuyerOptions, BatchRecord } from './batch-session-types';

export async function buildBuyerOpening(
  record: BatchRecord,
  payer: BatchBuyerOptions['payer'],
) {
  const hints = record.hints;
  if (!hints) return sessionFail(SESSION_CODES.UNVERIFIED);
  const terms = record.terms;
  const requirements = await requirementsFor(terms);
  return buildDepositPayload({
    payer,
    receiver: terms.payTo,
    receiverAuthorizer: terms.authorizer,
    mint: terms.mint,
    feePayer: terms.feePayer,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    blockhash: {
      blockhash: blockhash(hints.blockhash),
      lastValidBlockHeight: BigInt(hints.lastValidBlockHeight),
    },
    openSlot: BigInt(hints.slot),
    salt: BigInt(record.salt),
    depositAmount: BigInt(terms.depositAtomic),
    firstCharge: 0n,
    allowZeroFirstCharge: true,
    withdrawDelay: terms.withdrawDelaySeconds,
    memo: String(requirements.extra?.memo),
    splits: paymentSplits(terms),
  });
}
