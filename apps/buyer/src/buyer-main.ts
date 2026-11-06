// One buyer entry: verify a signed quote first, then execute free or prepare its paid channel.
import { isMain } from '@gyblos/runtime';

import { main } from './free-main';
import { startFreeBuyer } from './free-startup';
import type { PaidBuyerHost, startPaidBuyer } from './paid-startup';
import { quoteBuyerExecution } from './quote-startup';

export async function startBuyer(
  options: Parameters<typeof startPaidBuyer>[0] = {},
): Promise<PaidBuyerHost> {
  return startFreeBuyer({
    ...options,
    execution: quoteBuyerExecution(options),
  });
}

if (isMain(import.meta.url)) await main(startBuyer);
