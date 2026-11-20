// Prepares the desktop's private buyer home and delegates startup on its stable loopback port.
// The caller owns the role and listener; existing settings are never replaced here.
import { PORTS } from '@gyblos/config';
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

// The host owns transport creation, and preparation never replaces existing settings.
export async function startDesktopBuyer<Host>(
  options: BuyerInitOptions,
  start: (options: { port: number }) => Promise<Host>,
): Promise<Host> {
  await prepareDesktopBuyer(options);
  options.signal?.throwIfAborted();
  return start({ port: PORTS.desktopBuyer });
}
