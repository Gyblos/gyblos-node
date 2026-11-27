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
  UnsentChannelLimitError,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

export { UnsentChannelLimitError } from '@gyblos/protocol/payment-session';

export interface BuyerSessionPolicy {
  depositAtomic: string;
  totalDepositAtomic?: string;
  renewalBudgetAtomic?: string;
  lifetimeMs: number;
  withdrawDelaySeconds: number;
}
export function parseBuyerSessionPolicy(value: unknown): BuyerSessionPolicy {
  try {
    if (!value || typeof value !== 'object') return sessionFail();
    const optional = Object.hasOwn(value, 'withdrawDelaySeconds');
    const hasTotal = Object.hasOwn(value, 'totalDepositAtomic');
    const hasBudget = Object.hasOwn(value, 'renewalBudgetAtomic');
    const row = controlObject(value, [
      'depositAtomic',
      'lifetimeMs',
      ...(hasTotal ? ['totalDepositAtomic'] : []),
      ...(hasBudget ? ['renewalBudgetAtomic'] : []),
      ...(optional ? ['withdrawDelaySeconds'] : []),
    ]);
    const depositAtomic = controlAtomic(row.depositAtomic);
    const renewalBudgetAtomic = hasBudget
      ? positiveTotal(row.renewalBudgetAtomic)
      : undefined;
    if (
      (renewalBudgetAtomic !== undefined &&
        (hasTotal || BigInt(renewalBudgetAtomic) < BigInt(depositAtomic))) ||
      depositAtomic === '0' ||
      BigInt(depositAtomic) > BigInt(BATCH_SESSION_DEFAULTS.maxDepositAtomic)
    )
      sessionFail();
    return {
      depositAtomic,
      ...(renewalBudgetAtomic && { renewalBudgetAtomic }),
      ...(hasTotal
        ? { totalDepositAtomic: positiveTotal(row.totalDepositAtomic) }
        : {}),
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

// Existing journals retain their original terms; only fresh generations require a minimum deposit.
export function newSessionTerms(
  quote: SignedOfferV2,
  policy: BuyerSessionPolicy,
  now: number,
) {
  const available = BigInt(policy.depositAtomic);
  if (
    available < BigInt(BATCH_SESSION_DEFAULTS.minDepositAtomic) ||
    available < BigInt(quote.offer.maxAtomic)
  )
    throw new UnsentChannelLimitError(quote.offer.nodeId);
  return sessionTerms(quote, policy, now);
}

function positiveTotal(value: unknown) {
  const total = controlAtomic(value);
  if (total === '0') return sessionFail();
  return total;
}

export function replacementTerms(
  policy: BuyerSessionPolicy,
  now: () => number,
  quote: SignedOfferV2,
  priorSpentAtomic?: string,
) {
  const cap = BigInt(policy.depositAtomic);
  const authority =
    BigInt(policy.renewalBudgetAtomic ?? policy.depositAtomic) -
    BigInt(priorSpentAtomic ?? '0');
  return (spent: string) => {
    const available = authority - BigInt(spent);
    return newSessionTerms(
      quote,
      { ...policy, depositAtomic: String(available < cap ? available : cap) },
      now(),
    );
  };
}
