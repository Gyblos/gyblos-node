// Seller billing override for the inference gate: inflates or deflates output tokens for two chosen
// request IDs so overcharge and undercharge detection can be exercised.
import type { TokenCounts } from '@gyblos/core/metering';

import { GATE_CASES } from '../../constants.js';

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
