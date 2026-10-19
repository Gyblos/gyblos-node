export interface TokenCounts {
  input: number;
  output: number;
}
export const PRICES = { inputAtomic: '1', outputAtomic: '2' } as const;
// Fixed before measuring, applied independently to input and output counts.
export const TOLERANCE = { absoluteTokens: 2, relativePercent: 2 } as const;
export const OFFER_ID = 'qwen3-0.6b-local-v1';

export function charge(counts: TokenCounts): bigint {
  for (const value of Object.values(counts))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid token count.');
  return (
    BigInt(counts.input) * BigInt(PRICES.inputAtomic) +
    BigInt(counts.output) * BigInt(PRICES.outputAtomic)
  );
}
export function tokenAllowance(count: number): number {
  return Math.max(
    TOLERANCE.absoluteTokens,
    Math.ceil((count * TOLERANCE.relativePercent) / 100),
  );
}
export function compareUsage(engine: TokenCounts, recounted: TokenCounts) {
  charge(engine);
  charge(recounted);
  const inputDelta = engine.input - recounted.input;
  const outputDelta = engine.output - recounted.output;
  return {
    inputDelta,
    outputDelta,
    withinTolerance:
      Math.abs(inputDelta) <= tokenAllowance(recounted.input) &&
      Math.abs(outputDelta) <= tokenAllowance(recounted.output),
  };
}
export function assessCharge(
  actual: bigint,
  recounted: TokenCounts,
  delivered: boolean,
  failed: boolean,
) {
  const expected = failed ? 0n : charge(recounted);
  const allowance = failed
    ? 0n
    : charge({
        input: tokenAllowance(recounted.input),
        output: tokenAllowance(recounted.output),
      });
  const difference = actual - expected;
  return {
    expectedAtomic: expected.toString(),
    differenceAtomic: difference.toString(),
    allowanceAtomic: allowance.toString(),
    relativeDifference:
      expected === 0n
        ? actual === 0n
          ? 0
          : null
        : Number(difference) / Number(expected),
    anomaly:
      actual > expected + allowance
        ? 'overcharge'
        : failed
          ? 'failed'
          : !delivered
            ? 'incomplete'
            : 'none',
  };
}
