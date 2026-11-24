// Inert composition shared by buyer entrypoints; importing it starts no process or endpoint.
import { startFreeBuyer } from './free-startup';
import { quoteBuyerExecution } from './quote-startup';
import type { BuyerStartupOptions } from './session-requirements';

type FreeHost = Awaited<ReturnType<typeof startFreeBuyer>>;
type BuyerHost = FreeHost & {
  chat: FreeHost['chat'] & { automatic?: boolean };
};
export async function startBuyer(
  options: BuyerStartupOptions = {},
): Promise<BuyerHost> {
  return startFreeBuyer({
    ...options,
    execution: quoteBuyerExecution(options),
  });
}
