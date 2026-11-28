// Buyer-authorized reusable-session limits, independent of each quote's request ceiling.
import { PROTOCOL_FEE } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { matchBatchTerms } from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import {
  controlAddress,
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
  fundedChannelId?: string;
  lifetimeMs: number;
  withdrawDelaySeconds: number;
}
export function parseBuyerSessionPolicy(value: unknown): BuyerSessionPolicy {
  try {
    if (!value || typeof value !== 'object') return sessionFail();
    const optional = Object.hasOwn(value, 'withdrawDelaySeconds');
    const hasTotal = Object.hasOwn(value, 'totalDepositAtomic');
    const hasBudget = Object.hasOwn(value, 'renewalBudgetAtomic');
    const hasFunded = Object.hasOwn(value, 'fundedChannelId');
    const row = controlObject(value, [
      'depositAtomic',
      'lifetimeMs',
      ...(hasTotal ? ['totalDepositAtomic'] : []),
      ...(hasBudget ? ['renewalBudgetAtomic'] : []),
      ...(optional ? ['withdrawDelaySeconds'] : []),
      ...(hasFunded ? ['fundedChannelId'] : []),
    ]);
    const depositAtomic = controlAtomic(row.depositAtomic);
    const renewalBudgetAtomic = hasBudget
      ? positiveTotal(row.renewalBudgetAtomic)
      : undefined;
    if (
      (hasFunded && (hasBudget || hasTotal)) ||
      (renewalBudgetAtomic !== undefined &&
        (hasTotal || BigInt(renewalBudgetAtomic) < BigInt(depositAtomic))) ||
      depositAtomic === '0' ||
      BigInt(depositAtomic) > BigInt(BATCH_SESSION_DEFAULTS.maxDepositAtomic)
    )
      sessionFail();
    return {
      depositAtomic,
      ...(renewalBudgetAtomic && { renewalBudgetAtomic }),
      ...(hasFunded && {
        fundedChannelId: controlAddress(row.fundedChannelId),
      }),
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

type DepositPolicy = Pick<
  BuyerSessionPolicy,
  'depositAtomic' | 'renewalBudgetAtomic'
>;
export function spendingAuthority(policy: DepositPolicy) {
  return policy.renewalBudgetAtomic ?? policy.depositAtomic;
}

export function checkChannelAuthority(
  policy: BuyerSessionPolicy,
  terms: PaymentSessionTerms,
  priorSpent: string,
  now: number,
  nodeId: string,
) {
  if (
    BigInt(terms.depositAtomic) > BigInt(policy.depositAtomic) ||
    (!policy.fundedChannelId &&
      BigInt(priorSpent) + BigInt(terms.depositAtomic) >
        BigInt(spendingAuthority(policy))) ||
    terms.withdrawDelaySeconds > policy.withdrawDelaySeconds ||
    terms.protocolFeeBps !== PROTOCOL_FEE.bps ||
    terms.treasury !== PROTOCOL_FEE.treasury ||
    terms.expiresAt - now > policy.lifetimeMs
  )
    throw new UnsentChannelLimitError(nodeId);
}

export function remainingDepositAuthority(
  policy: DepositPolicy,
  priorSpentAtomic: string | undefined,
  spent: string,
) {
  const cap = BigInt(policy.depositAtomic);
  const available =
    BigInt(spendingAuthority(policy)) -
    BigInt(priorSpentAtomic ?? '0') -
    BigInt(spent);
  return available < cap ? available : cap;
}

export function replacementTerms(
  policy: BuyerSessionPolicy,
  now: () => number,
  quote: SignedOfferV2,
  priorSpentAtomic?: string,
) {
  return (spent: string) => {
    return newSessionTerms(
      quote,
      {
        ...policy,
        depositAtomic: String(
          remainingDepositAuthority(policy, priorSpentAtomic, spent),
        ),
      },
      now(),
    );
  };
}
