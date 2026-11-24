// Optional buyer-wide spending limit in the preview; unset until the buyer sets one (GYB-DOC-045).
import { DEVNET_USDC } from '@gyblos/config/network';
import { buyerAtomic } from '@gyblos/protocol/buyer-api';

export function accountBudgetSnapshot(
  limitAtomic: string,
  replies: ReadonlyArray<{ chargeAtomic: string }>,
  limited: boolean,
) {
  const chatSpend = replies.reduce(
    (sum, reply) => sum + BigInt(reply.chargeAtomic),
    0n,
  );
  return {
    mint: DEVNET_USDC,
    limitAtomic,
    limited,
    spentAtomic: String(chatSpend),
  };
}

export function accountLimitError(limit: string, spent: string) {
  if (!buyerAtomic(limit)) return 'Enter a valid chat budget.';
  if (BigInt(limit) < BigInt(spent))
    return 'The budget must cover USDC already spent.';
  return null;
}
