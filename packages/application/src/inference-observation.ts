import type { EngineUsage } from '../../inference-ollama/src/index.js';
import { compareUsage, charge } from './metering.js';

export interface ObservedBody {
  requestId: string;
  offer?: string;
  model?: string;
  digest?: string;
  content?: string;
  usage?: EngineUsage;
  billedTokens?: { input: number; output: number };
  done?: boolean;
  doneReason?: string;
}

export function observeInferenceResponse(input: {
  status: number;
  body: unknown;
  expected: { requestId: string; offer: string; model: string; digest: string };
  inputTokens: number;
  countOutput: (text: string) => number;
}) {
  const raw = input.body as ObservedBody;
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.requestId !== input.expected.requestId
  ) {
    throw new Error('Inference response identity does not match the request.');
  }
  const failed = input.status !== 200;
  const body: ObservedBody = { requestId: raw.requestId };
  if (!failed) {
    if (typeof raw.content !== 'string' || raw.content.length === 0)
      throw new Error('Malformed successful inference response.');
    if (
      raw.offer !== input.expected.offer ||
      raw.model !== input.expected.model ||
      raw.digest !== input.expected.digest
    )
      throw new Error(
        'Seller offer/model identity does not match the pinned offer.',
      );
    if (!raw.usage || !raw.billedTokens)
      throw new Error('Missing inference usage.');
    const usage = {} as EngineUsage;
    for (const key of [
      'prompt_eval_count',
      'eval_count',
      'total_duration',
      'load_duration',
      'prompt_eval_duration',
      'eval_duration',
    ] as const) {
      const value = raw.usage[key];
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('Invalid inference usage.');
      usage[key] = value;
    }
    const billedTokens = {
      input: raw.billedTokens.input,
      output: raw.billedTokens.output,
    };
    charge(billedTokens);
    Object.assign(body, {
      offer: raw.offer,
      model: raw.model,
      digest: raw.digest,
      content: raw.content,
      usage,
      billedTokens,
      done: raw.done === true,
      doneReason:
        raw.doneReason === 'stop' || raw.doneReason === 'length'
          ? raw.doneReason
          : 'unknown',
    });
  }
  const text = body.content ?? '';
  const recounted = {
    input: input.inputTokens,
    output: input.countOutput(text),
  };
  const engineTokens = body.usage
    ? { input: body.usage.prompt_eval_count, output: body.usage.eval_count }
    : null;
  const delivered = !failed && body.done === true && body.doneReason === 'stop';
  const comparison = engineTokens
    ? compareUsage(engineTokens, recounted)
    : null;
  return { body, failed, text, recounted, engineTokens, delivered, comparison };
}
