// Prepares the desktop's dedicated buyer home through the shared, exclusive initializer.
// The caller owns the environment and role port; no state is replaced or network started here.
import {
  buyerInitDefaults,
  checkBuyerInit,
  initializeBuyer,
  type BuyerInitOptions,
} from '@gyblos/node/buyer-init';

export async function prepareDesktopBuyer(
  options: BuyerInitOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  const current = await checkBuyerInit(options.environment);
  if (!current.exists) await initializeBuyer(buyerInitDefaults(), options);
}
