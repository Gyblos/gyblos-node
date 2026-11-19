// One USDC budget covers every simulated chat and API key on the account.
import { DEVNET_USDC } from '@gyblos/config/network';
import { buyerAtomic } from '@gyblos/protocol/buyer-api';

export function accountBudgetSnapshot(
  limitAtomic: string,
  keys: ReadonlyArray<{ spentAtomic: string }>,
  replies: ReadonlyArray<{ chargeAtomic: string }>,
) {
  const apiSpend = keys.reduce((sum, key) => sum + BigInt(key.spentAtomic), 0n);
  const chatSpend = replies.reduce(
    (sum, reply) => sum + BigInt(reply.chargeAtomic),
    0n,
  );
  return {
    mint: DEVNET_USDC,
    limitAtomic,
    spentAtomic: String(apiSpend + chatSpend),
  };
}

export function accountLimitError(limit: string, spent: string) {
  if (!buyerAtomic(limit)) return 'Enter a valid account budget.';
  if (BigInt(limit) < BigInt(spent))
    return 'The budget must cover USDC already spent.';
  return null;
}
