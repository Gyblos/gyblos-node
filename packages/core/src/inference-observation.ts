import { HTTP_STATUS } from '@gyblos/config';
import type { EngineWireUsage as EngineUsage } from '@gyblos/protocol/wire-usage';

import { OBSERVED_DONE_REASONS, type ObservedDoneReason } from './constants.js';
import { charge, compareUsage, type TokenCounts } from './metering.js';

export interface ObservedBody {
  requestId: string;
  offer?: string;
  model?: string;
  digest?: string;
  content?: string;
  usage?: EngineUsage;
  billedTokens?: TokenCounts;
  done?: boolean;
  doneReason?: ObservedDoneReason;
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
  const failed = input.status !== HTTP_STATUS.ok;
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
    const rawUsage = raw.usage;
    const usageValue = (key: keyof EngineUsage): number => {
      const value = rawUsage[key];
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('Invalid inference usage.');
      return value;
    };
    const usage: EngineUsage = {
      prompt_eval_count: usageValue('prompt_eval_count'),
      eval_count: usageValue('eval_count'),
      total_duration: usageValue('total_duration'),
      load_duration: usageValue('load_duration'),
      prompt_eval_duration: usageValue('prompt_eval_duration'),
      eval_duration: usageValue('eval_duration'),
    };
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
        raw.doneReason === OBSERVED_DONE_REASONS.STOP ||
        raw.doneReason === OBSERVED_DONE_REASONS.LENGTH
          ? raw.doneReason
          : OBSERVED_DONE_REASONS.UNKNOWN,
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
  const delivered =
    !failed &&
    body.done === true &&
    body.doneReason === OBSERVED_DONE_REASONS.STOP;
  const comparison = engineTokens
    ? compareUsage(engineTokens, recounted)
    : null;
  return { body, failed, text, recounted, engineTokens, delivered, comparison };
}
