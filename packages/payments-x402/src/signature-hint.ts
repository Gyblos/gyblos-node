import { isSignature, type Signature } from '@solana/kit';

export function signatureHint(value: unknown): Signature | undefined {
  try {
    return typeof value === 'string' && isSignature(value) ? value : undefined;
  } catch {
    // Optional diagnostic metadata cannot replace a payment result or error.
    return undefined;
  }
}
