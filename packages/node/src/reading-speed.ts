// Learns how fast an offer's engine reads a prompt (input tokens per second), so its quotes can refuse a
// request it would not finish reading in time. Every generation the engine reports how long it spent on
// the input is a measurement; a prompt shorter than PROMPT_READING.minSampleTokens (mostly cached, or tiny)
// is not. A request that ran out of time before its first token bounds the speed from above: those input
// tokens were not read in that time. In memory only; a restarted seller measures again.
import { PROMPT_READING } from '@gyblos/config';
import { ENGINE_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  EngineError,
  type Engine,
  type EngineInput,
} from '@gyblos/protocol/engine';

const NANOSECONDS_PER_SECOND = 1e9;
const MILLISECONDS_PER_SECOND = 1_000;

export function readingSpeedEngine(
  engine: Engine,
  now: () => number = () => performance.now(),
) {
  let speed: number | undefined;
  const measured = (sample: number) => {
    if (!Number.isFinite(sample) || sample <= 0) return;
    speed =
      speed === undefined
        ? sample
        : speed + (sample - speed) * PROMPT_READING.sampleWeight;
  };
  const generate = async (input: EngineInput) => {
    let answering = false;
    const started = now();
    const onFragment = async () => {
      answering = true;
      await input.onFragment?.();
    };
    try {
      const result = await engine.generate({ ...input, onFragment });
      const { inputTokens, inputDurationNs } = result.usage;
      if (inputTokens >= PROMPT_READING.minSampleTokens && inputDurationNs > 0)
        measured(inputTokens / (inputDurationNs / NANOSECONDS_PER_SECOND));
      return result;
    } catch (error) {
      const elapsedMs = now() - started;
      if (
        error instanceof EngineError &&
        error.code === ENGINE_ERROR_CODES.TIMEOUT &&
        !answering &&
        input.inputTokens !== undefined &&
        input.inputTokens >= PROMPT_READING.minSampleTokens &&
        elapsedMs > 0
      ) {
        const bound = input.inputTokens / (elapsedMs / MILLISECONDS_PER_SECOND);
        speed = speed === undefined ? bound : Math.min(speed, bound);
      }
      throw error;
    }
  };
  return {
    engine: {
      describe: () => engine.describe(),
      capabilities: () => engine.capabilities(),
      ...(engine.supportsTools
        ? { supportsTools: () => engine.supportsTools!() }
        : {}),
      generate,
    } satisfies Engine,
    tokensPerSecond: () => speed,
  };
}
