// Synthetic rolling checkpoint metadata for product and VM tests; no response content or real payment.
import type { SessionRequest } from '@gyblos/protocol/payment-session';
import type { SessionBlockIntent } from '@gyblos/protocol/session-blocks';

export function blockIntent(
  request: SessionRequest,
  index: number,
  amount: string,
  terminal = false,
  baseAtomic = '0',
): SessionBlockIntent {
  return {
    index,
    digest: (index + 1).toString(16).padStart(64, '0'),
    usage: { inputTokens: 2, outputTokens: index + 1 },
    bill: {
      ...request,
      chargedAtomic: amount,
      cumulativeAtomic: String(BigInt(baseAtomic) + BigInt(amount)),
    },
    terminal,
  };
}
