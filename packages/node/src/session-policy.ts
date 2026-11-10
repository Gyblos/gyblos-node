// Buyer-authorized reusable-session limits, independent of each quote's request ceiling.
import { PROTOCOL_FEE } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { matchBatchTerms } from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import {
  controlAtomic,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  SESSION_CODES,
  sessionFail,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

export interface BuyerSessionPolicy {
  depositAtomic: string;
  lifetimeMs: number;
  withdrawDelaySeconds: number;
}
export function parseBuyerSessionPolicy(value: unknown): BuyerSessionPolicy {
  try {
    const optional =
      value !== null &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'withdrawDelaySeconds');
    const row = controlObject(value, [
      'depositAtomic',
      'lifetimeMs',
      ...(optional ? ['withdrawDelaySeconds'] : []),
    ]);
    const depositAtomic = controlAtomic(row.depositAtomic);
    if (
      depositAtomic === '0' ||
      BigInt(depositAtomic) > BigInt(BATCH_SESSION_DEFAULTS.maxDepositAtomic)
    )
      sessionFail();
    return {
      depositAtomic,
      lifetimeMs: controlInteger(
        row.lifetimeMs,
        BATCH_SESSION_DEFAULTS.minLifetimeMs,
        BATCH_SESSION_DEFAULTS.maxLifetimeMs,
      ),
      withdrawDelaySeconds: controlInteger(
        optional
          ? row.withdrawDelaySeconds
          : BATCH_SESSION_DEFAULTS.withdrawDelaySeconds,
        BATCH_SESSION_DEFAULTS.withdrawDelaySeconds,
        BATCH_SESSION_DEFAULTS.maxWithdrawDelaySeconds,
      ),
    };
  } catch {
    return sessionFail();
  }
}
export function sessionTerms(
  quote: SignedOfferV2,
  input: BuyerSessionPolicy,
  now: number,
): PaymentSessionTerms {
  const policy = parseBuyerSessionPolicy(input);
  const offer = quote.offer;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    BigInt(offer.maxAtomic) > BigInt(policy.depositAtomic)
  )
    return sessionFail(SESSION_CODES.LIMIT);
  const terms = {
    buyer: offer.buyer,
    buyerNodeId: offer.buyerNodeId,
    owner: offer.owner,
    sellerNodeId: offer.nodeId,
    network: offer.network,
    mint: offer.mint,
    payTo: offer.payTo,
    feePayer: offer.feePayer,
    authorizer: offer.authorizer,
    treasury: PROTOCOL_FEE.treasury,
    protocolFeeBps: PROTOCOL_FEE.bps,
    depositAtomic: policy.depositAtomic,
    expiresAt: now + policy.lifetimeMs,
    withdrawDelaySeconds: policy.withdrawDelaySeconds,
  };
  return matchBatchTerms(terms, terms);
}
