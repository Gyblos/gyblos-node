// Runs isolated simulated paid startup; never accepts a real home or external service overrides.
import type { PaidAcceptanceReport } from './paid-acceptance-constants';
export async function runPaidAcceptance(_options: { signal?: AbortSignal } = {}): Promise<PaidAcceptanceReport> {
  throw new Error('Not implemented');
}
export function parsePaidReport(_text: string): PaidAcceptanceReport {
  throw new Error('Not implemented');
}
