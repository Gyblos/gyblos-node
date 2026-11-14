// Inert composition shared by buyer entrypoints; importing it starts no process or endpoint.
import { startFreeBuyer } from './free-startup';
import type { PaidBuyerHost, startPaidBuyer } from './paid-startup';
import { quoteBuyerExecution } from './quote-startup';

type BuyerHost = PaidBuyerHost & Awaited<ReturnType<typeof startFreeBuyer>>;
export async function startBuyer(
  options: Parameters<typeof startPaidBuyer>[0] = {},
): Promise<BuyerHost> {
  return startFreeBuyer({
    ...options,
    execution: quoteBuyerExecution(options),
  });
}
