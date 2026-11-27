import { ROLE_FILES, rolePathIn, type HomeEnvironment } from '@gyblos/config';
import { checkBuyerInit } from '@gyblos/node/buyer-init';
import { withStoppedBuyer } from '@gyblos/node/buyer-runtime';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';
import {
  acquireProcessLock,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { BUYER_SELECTION } from './constants';
import { parseBuyerSelectionConfig } from './selection-config';

export class AutoSettingsError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AutoSettingsError('Invalid buyer settings.');
  return Object.fromEntries(Object.entries(value));
}

export function withAutoPrices(value: unknown, prices: TokenPricesV2 | null) {
  const config = parseBuyerSelectionConfig(value);
  if (!config.discovery?.open || config.sellers.length || config.pinnedNodeId)
    throw new AutoSettingsError(
      'Auto needs an open-discovery buyer without a pinned or configured seller.',
    );
  if (prices && (!config.session || config.request.maxAtomic === '0'))
    throw new AutoSettingsError(
      'Set a positive maximum per response and a channel policy before enabling paid Auto.',
    );
  const raw = record(value);
  const discovery = record(raw.discovery);
  if (!prices) delete discovery.paidAuto;
  else discovery.paidAuto = true;
  const next = {
    ...raw,
    discovery,
    ...(prices && {
      request: { ...record(raw.request), priceCeilings: prices },
    }),
  };
  parseBuyerSelectionConfig(next);
  return next;
}

function withRenewalBudget(value: unknown, budget: string | null) {
  const config = parseBuyerSelectionConfig(value);
  if (!config.session)
    throw new AutoSettingsError(
      'Set a channel policy before configuring a renewal budget.',
    );
  if (
    budget !== null &&
    (config.session.totalDepositAtomic !== undefined ||
      BigInt(budget) < BigInt(config.session.depositAtomic))
  )
    throw new AutoSettingsError(
      'A renewal budget requires single-channel mode and sufficient authority for one deposit.',
    );
  const raw = record(value);
  const session = record(raw.session);
  if (budget === null) delete session.renewalBudgetAtomic;
  else session.renewalBudgetAtomic = budget;
  const next = { ...raw, session };
  parseBuyerSelectionConfig(next);
  return next;
}

export function setBuyerRenewalBudget(
  environment: HomeEnvironment,
  budget: string | null,
) {
  return withStoppedBuyer(environment, async () => {
    const lock = await acquireProcessLock(
      rolePathIn(environment, P2P_ROLES.BUYER, ROLE_FILES.buyerInitLock),
    );
    try {
      const { path, exists } = await checkBuyerInit(environment);
      if (!exists) throw new AutoSettingsError('Run buyer:init first.');
      const data = await readPrivateFile(path, BUYER_SELECTION.maxConfigBytes);
      if (!data) throw new AutoSettingsError('Missing buyer settings.');
      const raw: unknown = JSON.parse(data);
      const next = withRenewalBudget(raw, budget);
      await lock.verify();
      await writePrivateFile(
        path,
        JSON.stringify(next, null, 2) + '\n',
        BUYER_SELECTION.maxConfigBytes,
      );
    } finally {
      await lock.release();
    }
  });
}
