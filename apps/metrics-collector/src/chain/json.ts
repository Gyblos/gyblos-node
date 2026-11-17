// Owns the boundary checks for Solana RPC answers: read as unknown, checked here before the chain
// index uses them. A failed check throws ChainShapeError.
export class ChainShapeError extends Error {
  constructor(where: string) {
    super(`unexpected chain answer: ${where}`);
    this.name = 'ChainShapeError';
  }
}

export function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ChainShapeError(where);
  return value as Record<string, unknown>;
}
export function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new ChainShapeError(where);
  return value;
}
export function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new ChainShapeError(where);
  return value;
}
export function num(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new ChainShapeError(where);
  return value;
}
export const nullable = <T>(
  value: unknown,
  read: (present: unknown) => T,
): T | null => (value === null || value === undefined ? null : read(value));
