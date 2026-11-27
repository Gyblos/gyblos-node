// Main-process wiring; renderer receives only its validated buyer address and atomic amounts.
import { clipboard, ipcMain, shell, type BrowserWindow } from 'electron';

import type { PaidChannelEligibility } from '@gyblos/buyer/channel-eligibility';
import type { HomeEnvironment } from '@gyblos/config/home';
import {
  buyerUsdcBalance,
  localFundingRole,
  switchingCredit,
} from '@gyblos/node/buyer-funding';
import type {
  BuyerApiPolicy,
  BuyerSellerChoice,
} from '@gyblos/protocol/buyer-api';

import { fundingHandlers } from './handlers';
import { FUNDING } from './model';

export function registerFunding(
  window: BrowserWindow,
  environment: HomeEnvironment,
  policy: () => BuyerApiPolicy | null,
  managed: () => boolean,
  inspectChannel: (
    seller: BuyerSellerChoice,
  ) => Promise<PaidChannelEligibility>,
  resolveOffer: (id: string) => BuyerSellerChoice | undefined,
) {
  const handlers = fundingHandlers({
    accepts: (event) =>
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame,
    policy,
    rpcUrl: async (current) =>
      (await localFundingRole(environment, current))?.rpcUrl ?? null,
    balance: buyerUsdcBalance,
    resolveOffer,
    switching: (current, seller) =>
      managed()
        ? switchingCredit(environment, current, seller)
        : Promise.resolve(null),
    remaining: (_current, seller) => inspectChannel(seller),
    copy: (text) => clipboard.writeText(text),
    open: (url) => shell.openExternal(url),
  });
  ipcMain.handle(FUNDING.balance, (event, ...args: unknown[]) =>
    handlers.balance(event, args),
  );
  ipcMain.handle(FUNDING.copy, (event, ...args: unknown[]) =>
    handlers.copy(event, args),
  );
  ipcMain.handle(FUNDING.faucet, (event, ...args: unknown[]) =>
    handlers.faucet(event, args),
  );
  return () => {
    ipcMain.removeHandler(FUNDING.balance);
    ipcMain.removeHandler(FUNDING.copy);
    ipcMain.removeHandler(FUNDING.faucet);
  };
}
