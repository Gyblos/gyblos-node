// Composes the private reusable-channel journal; it never sends payments or reads a chain itself.
// Finality, verified delivery and correct seller identity are the caller's responsibility.
import type { HomeEnvironment } from '@gyblos/config/home';

import { REUSABLE_JOURNAL } from './constants';
import { createReusableChannelActions } from './reusable-journal-channels';
import { createClosureActions } from './reusable-journal-close';
import { createPreparationActions } from './reusable-journal-preparation';
import { openReusableStore } from './reusable-journal-store';
import { createReusableVoucherActions } from './reusable-journal-vouchers';

export type ReusableJournal = ReturnType<typeof createReusableChannelActions> &
  ReturnType<typeof createReusableVoucherActions> &
  ReturnType<typeof createClosureActions> &
  ReturnType<typeof createPreparationActions> & { close(): Promise<void> };
export async function openReusableJournal(options: {
  environment: HomeEnvironment;
  maxBytes?: number;
}): Promise<ReusableJournal> {
  const store = await openReusableStore(
    options.environment,
    options.maxBytes ?? REUSABLE_JOURNAL.maxBytes,
  );
  return {
    ...createReusableChannelActions(store),
    ...createClosureActions(store),
    ...createPreparationActions(store),
    ...createReusableVoucherActions(store),
    close: store.close,
  };
}
