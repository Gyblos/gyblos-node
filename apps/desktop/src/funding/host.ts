// Main-process wiring; renderer receives only its validated buyer address and atomic amounts.
import { clipboard, ipcMain, shell, type BrowserWindow } from 'electron';

import {
  observeChannelAt,
  paidChannelEligibility,
} from '@gyblos/buyer/channel-eligibility';
import { PAYMENT_REVIEW } from '@gyblos/buyer/constants';
import { loadBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
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
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { fundingHandlers } from './handlers';
import { FUNDING } from './model';

export function registerFunding(
  window: BrowserWindow,
  environment: HomeEnvironment,
  policy: () => BuyerApiPolicy | null,
  managed: () => boolean,
  credentialBlocked: () => Promise<boolean>,
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
    remaining: async (current, seller, rpcUrl) => {
      try {
        const [blocked, config] = await Promise.all([
          credentialBlocked(),
          managed() ? loadBuyerSelectionConfig(environment) : undefined,
        ]);
        return paidChannelEligibility(
          environment,
          {
            ...current,
            ...seller,
            credentialBlocked: blocked,
            pinnedNodeId: config?.pinnedNodeId,
          },
          Date.now,
          observeChannelAt(rpcUrl),
          AbortSignal.timeout(PAYMENT_REVIEW.deadlineMs),
        );
      } catch {
        return {
          blocker: SESSION_CODES.STATUS_UNKNOWN,
          channelRemainingAtomic: null,
        };
      }
    },
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
