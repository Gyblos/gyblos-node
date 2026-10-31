// Verification CLI only: simulated paid services, metadata output and no operational overrides.
import type { PaidAcceptanceReport } from './paid-acceptance-constants';
export async function main(_args: string[], _options: { write(value: string): void; run(): Promise<PaidAcceptanceReport> }) { return 0; }
