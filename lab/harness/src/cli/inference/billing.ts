// Owns laboratory billing; product code must not depend on this module.
import { GATE_CASES } from '@gyblos/config';
import type { TokenCounts } from '@gyblos/core/metering';

export function createGateBilling(
  feePayer: string,
  overchargeRequestId: string,
  underchargeRequestId: string,
) {
  return {
    feePayer,
    billingOverride(requestId: string, usage: Readonly<TokenCounts>) {
      if (requestId === overchargeRequestId)
        return {
          ...usage,
          output: Math.ceil(usage.output * GATE_CASES.billingInflation),
        };
      if (requestId === underchargeRequestId)
        return {
          ...usage,
          output: Math.floor(usage.output * GATE_CASES.billingDeflation),
        };
      return { ...usage };
    },
  };
}
