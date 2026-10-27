// Creates a seller with an incremental synthetic engine and temporary in-memory quote state.
// It never starts transport, payments, real engines or local identities.
import { createSellerFreeExecution } from '@gyblos/node/free-execution';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { EngineInput, EngineResult } from '@gyblos/protocol/engine';

import { freeSellerFixture } from './free-seller';

export function streamResult(text = 'answer'): EngineResult {
  return {
    text,
    usage: {
      inputTokens: 4,
      outputTokens: 2,
      totalDurationNs: 0,
      loadDurationNs: 0,
      inputDurationNs: 0,
      outputDurationNs: 0,
    },
    finishReason: ENGINE_DONE_REASONS.STOP,
  };
}
export async function freeStreamSellerFixture(
  caps = { dailyTokenCap: 100, perBuyerCap: 50 },
) {
  const base = await freeSellerFixture(caps);
  let calls = 0;
  let generate = async (input: EngineInput) => {
    await input.onText?.('an');
    await input.onText?.('swer');
    return streamResult();
  };
  const options = {
    ...base.options,
    engine: {
      ...base.options.engine,
      async generate(input: EngineInput) {
        calls++;
        return generate(input);
      },
    },
    tokenizer: {
      input: () => 4,
      count: (text: string) => Math.ceil(text.length / 3),
    },
  };
  return {
    ...base,
    options,
    service: createSellerFreeExecution(options),
    calls: () => calls,
    setGenerate(value: (input: EngineInput) => Promise<EngineResult>) {
      generate = value;
    },
  };
}
