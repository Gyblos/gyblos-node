// Optional response observations. These values never authorize, settle or verify a payment.
import {
  RESPONSE_COST_KIND,
  RESPONSE_COST_UNIT,
  RESPONSE_METRICS,
} from './constants';

export { RESPONSE_COST_UNIT, RESPONSE_COST_KIND } from './constants';

export type ResponseCost = {
  amount: string;
  unit: (typeof RESPONSE_COST_UNIT)[keyof typeof RESPONSE_COST_UNIT];
  kind: (typeof RESPONSE_COST_KIND)[keyof typeof RESPONSE_COST_KIND];
};
export type ResponseMetrics = {
  inputTokens: number | null;
  outputTokens: number | null;
  firstTokenMs: number | null;
  generationMs: number | null;
  responseMs: number | null;
  cost: ResponseCost | null;
};
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function duration(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= RESPONSE_METRICS.MAX_DURATION_MS)
  );
}
function cost(value: unknown): ResponseCost | null {
  const item = object(value);
  if (!item || Object.keys(item).sort().join(',') !== 'amount,kind,unit')
    return null;
  const unit = Object.values(RESPONSE_COST_UNIT).find(
    (entry) => entry === item.unit,
  );
  const kind = Object.values(RESPONSE_COST_KIND).find(
    (entry) => entry === item.kind,
  );
  if (
    !unit ||
    !kind ||
    typeof item.amount !== 'string' ||
    item.amount.length > RESPONSE_METRICS.MAX_AMOUNT_CHARACTERS
  )
    return null;
  const pattern =
    unit === RESPONSE_COST_UNIT.USD
      ? /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/
      : unit === RESPONSE_COST_UNIT.USDC
        ? /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/
        : /^(0|[1-9][0-9]*)$/;
  return pattern.test(item.amount) ? { amount: item.amount, unit, kind } : null;
}
export function parseResponseMetrics(value: unknown): ResponseMetrics | null {
  const item = object(value);
  if (
    !item ||
    Object.keys(item).sort().join(',') !==
      'cost,firstTokenMs,generationMs,inputTokens,outputTokens,responseMs'
  )
    return null;
  const input = item.inputTokens;
  const output = item.outputTokens;
  const charge = item.cost === null ? null : cost(item.cost);
  if (
    (input !== null && !count(input)) ||
    (output !== null && !count(output)) ||
    (typeof input === 'number' &&
      typeof output === 'number' &&
      !Number.isSafeInteger(input + output)) ||
    !duration(item.firstTokenMs) ||
    !duration(item.generationMs) ||
    !duration(item.responseMs) ||
    (item.cost !== null && !charge)
  )
    return null;
  return {
    inputTokens: input,
    outputTokens: output,
    firstTokenMs: item.firstTokenMs,
    generationMs: item.generationMs,
    responseMs: item.responseMs,
    cost: charge,
  };
}
export function reportedUsage(value: unknown, maxOutput: number) {
  const item = object(value);
  if (
    !item ||
    !count(item.prompt_tokens) ||
    !count(item.completion_tokens) ||
    item.completion_tokens > maxOutput ||
    !Number.isSafeInteger(item.prompt_tokens + item.completion_tokens) ||
    (item.total_tokens !== undefined &&
      item.total_tokens !== item.prompt_tokens + item.completion_tokens)
  )
    return null;
  return {
    inputTokens: item.prompt_tokens,
    outputTokens: item.completion_tokens,
  };
}
export function observedResponse(
  responseMs: number,
  charge: ResponseCost,
  usage: ReturnType<typeof reportedUsage> = null,
): ResponseMetrics {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    firstTokenMs: null,
    generationMs: null,
    responseMs: duration(responseMs) ? responseMs : null,
    cost: { ...charge },
  };
}
export function generationSpeed(metrics: ResponseMetrics | null | undefined) {
  return metrics?.outputTokens !== null &&
    metrics?.outputTokens !== undefined &&
    metrics.generationMs &&
    metrics.generationMs > 0
    ? (metrics.outputTokens * RESPONSE_METRICS.MS_PER_SECOND) /
        metrics.generationMs
    : null;
}
