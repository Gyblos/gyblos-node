// `pnpm buyer`: one loopback chat endpoint, paid on devnet when selection.json sets a deposit ceiling
// (request.maxAtomic above zero) and free otherwise. A selection.json that cannot be read starts the
// free buyer, which explains the problem.
import { isMain } from '@gyblos/runtime';

import { main } from './free-main';
import { startFreeBuyer } from './free-startup';
import { startPaidBuyer } from './paid-startup';
import { loadBuyerSelectionConfig } from './selection-config';

export async function paidSelected(): Promise<boolean> {
  const config = await loadBuyerSelectionConfig(process.env).catch(
    () => undefined,
  );
  return config !== undefined && config.request.maxAtomic !== '0';
}

export async function startBuyer(
  options: Parameters<typeof startPaidBuyer>[0] = {},
) {
  return (await paidSelected())
    ? startPaidBuyer(options)
    : startFreeBuyer(options);
}

if (isMain(import.meta.url)) await main(startBuyer);
