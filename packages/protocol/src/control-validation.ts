// Validates bounded control primitives with static typed errors; no I/O or SDKs.
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  PUBLIC_RECORD_LIMITS,
  REASONING_LEVELS,
  type ControlCode,
  type ReasoningLevel,
} from './constants';
import {
  publicAddress,
  publicHex,
  publicIdentifier,
  publicInteger,
  publicObject,
  PublicRecordError,
} from './public-validation';
import { verify } from './signing';

export class ControlError extends Error {
  constructor(readonly code: ControlCode) {
    super(code);
    this.name = 'ControlError';
  }
}
export function controlFail(code: ControlCode = CONTROL_CODES.INVALID): never {
  throw new ControlError(code);
}
// Runtimes may reject a malformed key at import; v2 callers see a static code, v1 keeps its behavior.
export async function controlVerify(
  ...input: Parameters<typeof verify>
): Promise<boolean> {
  try {
    return await verify(...input);
  } catch {
    return controlFail(CONTROL_CODES.SIGNATURE);
  }
}
export function controlPrimitive<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PublicRecordError) return controlFail();
    throw error;
  }
}
export const controlObject = (value: unknown, keys: readonly string[]) =>
  controlPrimitive(() => publicObject(value, keys));
export const controlInteger = (
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) => controlPrimitive(() => publicInteger(value, minimum, maximum));
export const controlAddress = (value: unknown) =>
  controlPrimitive(() => publicAddress(value));
export const controlHex = (
  value: unknown,
  bytes: number = CONTROL_LIMITS.digestBytes,
) => controlPrimitive(() => publicHex(value, bytes));
export const controlIdentifier = (value: unknown) =>
  controlPrimitive(() => publicIdentifier(value));
export function controlAtomic(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > PUBLIC_RECORD_LIMITS.maxAtomicDigits ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > BigInt(PUBLIC_RECORD_LIMITS.maxAtomic)
  )
    return controlFail();
  return value;
}
export function controlReasoning(value: unknown): ReasoningLevel {
  for (const level of Object.values(REASONING_LEVELS))
    if (value === level) return level;
  return controlFail();
}
export function controlNetwork(value: unknown): string {
  if (typeof value !== 'string' || !/^solana:[A-Za-z0-9]{1,32}$/.test(value))
    return controlFail();
  return value;
}
export function controlArray(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return controlFail();
  const detached: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, index);
    if (!property || !property.enumerable || !('value' in property))
      return controlFail();
    detached.push(property.value);
  }
  return detached;
}
export function controlText(
  value: unknown,
  max: number = PUBLIC_RECORD_LIMITS.maxIdentifierCharacters,
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return controlFail();
  return value;
}
