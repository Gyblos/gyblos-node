// Learns how fast an offer's engine reads a prompt (input tokens per second), so its quotes can refuse a
// request it would not finish reading in time. Only the engine's own report counts: every answer that
// says how long it spent on the input is a measurement. A prompt shorter than MIN_SAMPLE_TOKENS (mostly
// cached, or tiny) is not, and neither is a failure: a timeout's elapsed time also holds queueing, model
// loading and hidden reasoning, which are not reading. In memory only; a restarted seller measures again.
import type { Engine, EngineInput } from '@gyblos/protocol/engine';

const NANOSECONDS_PER_SECOND = 1e9;
// Prompts shorter than this do not measure a seller's reading speed.
const MIN_SAMPLE_TOKENS = 256;
// How much each new measurement moves the seller's estimate.
const SAMPLE_WEIGHT = 0.3;

export function readingSpeedEngine(engine: Engine) {
  let speed: number | undefined;
  const generate = async (input: EngineInput) => {
    const result = await engine.generate(input);
    const { inputTokens, inputDurationNs } = result.usage;
    const sample = inputTokens / (inputDurationNs / NANOSECONDS_PER_SECOND);
    if (
      inputTokens >= MIN_SAMPLE_TOKENS &&
      inputDurationNs > 0 &&
      Number.isFinite(sample)
    )
      speed =
        speed === undefined ? sample : speed + (sample - speed) * SAMPLE_WEIGHT;
    return result;
  };
  return {
    engine: {
      describe: () => engine.describe(),
      capabilities: () => engine.capabilities(),
      ...(engine.supportsTools
        ? { supportsTools: engine.supportsTools.bind(engine) }
        : {}),
      generate,
    } satisfies Engine,
    tokensPerSecond: () => speed,
  };
}
