// Builds only synthetic free sellers from shared acceptance components, with injected token counts.
// Caps and identities are ephemeral; no TOML, wallet file, tokenizer artifact or real engine is loaded.
import {
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { ACCEPTANCE_MODES } from './constants';
import { FREE_ACCEPTANCE } from './free-constants';
import { createAcceptanceSession, type AcceptanceSession } from './session';

export async function createFreeSeller(
  signal: AbortSignal,
  shared?: AcceptanceSession,
  limited = false,
) {
  const run = await createAcceptanceSession(
    ACCEPTANCE_MODES.SYNTHETIC,
    signal,
    {
      index: shared?.index,
      clock: shared?.clock,
      offer: {
        kind: OFFER_PRICING_KINDS.FREE,
        modelId: MODEL_IDS.QWEN3_0_6B,
        reasoning: [REASONING_LEVELS.OFF],
        caps: {
          dailyTokenCap: limited
            ? FREE_ACCEPTANCE.limitedDailyCap
            : FREE_ACCEPTANCE.dailyTokenCap,
          perBuyerCap: limited
            ? FREE_ACCEPTANCE.limitedBuyerCap
            : FREE_ACCEPTANCE.perBuyerCap,
        },
      },
      tokenizer: { input: () => 1, count: () => 1 },
    },
  );
  // The actual startup replay barrier excludes the starting tick; issue fresh quotes after it.
  try {
    await run.clock.advance(1);
    return run;
  } catch (error) {
    await run.close();
    throw error;
  }
}
