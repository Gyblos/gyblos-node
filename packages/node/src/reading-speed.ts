// Learns how fast an offer's engine reads a prompt (input tokens per second), so its quotes can refuse a
// request it would not finish reading in time. Every generation the engine reports how long it spent on
// the input is a measurement; a prompt shorter than PROMPT_READING.minSampleTokens (mostly cached, or tiny)
// is not. In memory only; a restarted seller measures again.
//
// A request that ran out of time before its first visible token also caps the estimate: those input tokens
// were not read in that time. Only when silence means reading: the engine has shown it reports visible
// fragments, and the request offered no tools (a tool call is generated without visible text). The cap
// lasts PROMPT_READING.timeoutCapMs or until a new measurement, so one slow moment does not keep the seller
// refusing large requests it never gets to measure.
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
  let measured: number | undefined;
  let cap: { speed: number; until: number } | undefined;
  let reportsFragments = false;
  const measure = (sample: number) => {
    if (!Number.isFinite(sample) || sample <= 0) return;
    cap = undefined;
    measured =
      measured === undefined
        ? sample
        : measured + (sample - measured) * PROMPT_READING.sampleWeight;
  };
  const generate = async (input: EngineInput) => {
    let answering = false;
    const started = now();
    const onFragment = async () => {
      answering = true;
      reportsFragments = true;
      await input.onFragment?.();
    };
    try {
      const result = await engine.generate({ ...input, onFragment });
      const { inputTokens, inputDurationNs } = result.usage;
      if (inputTokens >= PROMPT_READING.minSampleTokens && inputDurationNs > 0)
        measure(inputTokens / (inputDurationNs / NANOSECONDS_PER_SECOND));
      return result;
    } catch (error) {
      const elapsedMs = now() - started;
      if (
        error instanceof EngineError &&
        error.code === ENGINE_ERROR_CODES.TIMEOUT &&
        reportsFragments &&
        !answering &&
        !input.tools?.length &&
        input.inputTokens !== undefined &&
        input.inputTokens >= PROMPT_READING.minSampleTokens &&
        elapsedMs > 0
      ) {
        const bound = input.inputTokens / (elapsedMs / MILLISECONDS_PER_SECOND);
        cap = {
          speed: Math.min(bound, cap?.speed ?? bound),
          until: now() + PROMPT_READING.timeoutCapMs,
        };
      }
      throw error;
    }
  };
  const tokensPerSecond = () => {
    if (cap && now() >= cap.until) cap = undefined;
    if (!cap) return measured;
    return measured === undefined ? cap.speed : Math.min(measured, cap.speed);
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
    tokensPerSecond,
  };
}
