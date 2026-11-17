// Owns the boundary checks for external JSON: every source answer is read as unknown and checked here
// before the explorer uses it. A failed check throws SourceShapeError, which the source's caller turns
// into an unavailable section.
export class SourceShapeError extends Error {
  constructor(where: string) {
    super(`unexpected source shape: ${where}`);
    this.name = 'SourceShapeError';
  }
}
export type JsonRecord = Record<string, unknown>;

export function record(value: unknown, where: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SourceShapeError(where);
  return value as JsonRecord;
}
export function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new SourceShapeError(where);
  return value;
}
export function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new SourceShapeError(where);
  return value;
}
export function num(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new SourceShapeError(where);
  return value;
}
export const nullable = <T>(
  value: unknown,
  read: (present: unknown) => T,
): T | null => (value === null || value === undefined ? null : read(value));
export const flag = (value: unknown, where: string): boolean => {
  if (typeof value !== 'boolean') throw new SourceShapeError(where);
  return value;
};
// A JSON integer string such as an atomic amount.
export function integerText(value: unknown, where: string): string {
  const read = text(value, where);
  if (!/^-?\d+$/.test(read)) throw new SourceShapeError(where);
  return read;
}
