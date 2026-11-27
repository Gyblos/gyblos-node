// Builds only synthetic free sellers from shared acceptance components, with injected token counts.
// Caps and identities are ephemeral; no TOML, wallet file, tokenizer artifact or real engine is loaded.
import {
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { ACCEPTANCE_MODES, type AcceptanceMode } from './constants';
import type { EnginePace } from './engine';
import { FREE_ACCEPTANCE } from './free-constants';
import { createAcceptanceSession, type AcceptanceSession } from './session';

export async function createFreeSeller(
  signal: AbortSignal,
  shared?: Partial<
    Pick<AcceptanceSession, 'index' | 'clock' | 'admissionClock'>
  >,
  limited = false,
  engine: {
    mode?: AcceptanceMode;
    pace?: EnginePace;
    caps?: { dailyTokenCap: number; perBuyerCap: number };
  } = {},
) {
  const run = await createAcceptanceSession(
    engine.mode ?? ACCEPTANCE_MODES.SYNTHETIC,
    signal,
    {
      pace: engine.pace,
      index: shared?.index,
      clock: shared?.clock,
      admissionClock: shared?.admissionClock,
      offer: {
        kind: OFFER_PRICING_KINDS.FREE,
        modelId: MODEL_IDS.QWEN3_0_6B,
        reasoning: [REASONING_LEVELS.OFF],
        caps: {
          dailyTokenCap:
            engine.caps?.dailyTokenCap ??
            (limited
              ? FREE_ACCEPTANCE.limitedDailyCap
              : FREE_ACCEPTANCE.dailyTokenCap),
          perBuyerCap:
            engine.caps?.perBuyerCap ??
            (limited
              ? FREE_ACCEPTANCE.limitedBuyerCap
              : FREE_ACCEPTANCE.perBuyerCap),
          maxOutputTokens: FREE_ACCEPTANCE.maxOutputTokens,
        },
      },
      tokenizer: { input: () => 1, count: () => 1, chat: () => 1 },
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
