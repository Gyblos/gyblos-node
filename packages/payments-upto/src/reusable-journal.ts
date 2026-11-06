// Composes an experimental reusable-channel journal and delegates close submission to its caller.
// Callers verify seller identity and delivery; callbacks do not establish finality or rollback protection.
import type { HomeEnvironment } from '@gyblos/config/home';

import { REUSABLE_JOURNAL } from './constants';
import {
  resolveRecoveryAction,
  type ResolveRecoveryAction,
} from './reusable-control-resolve';
import {
  submitRecoveryAction,
  type SubmitRecoveryAction,
} from './reusable-control-submit';
import { createReusableChannelActions } from './reusable-journal-channels';
import { createClosureActions } from './reusable-journal-close';
import { createPreparationActions } from './reusable-journal-preparation';
import { openReusableStore } from './reusable-journal-store';
import { createReusableVoucherActions } from './reusable-journal-vouchers';

export type ReusableJournal = ReturnType<typeof createReusableChannelActions> &
  ReturnType<typeof createReusableVoucherActions> &
  ReturnType<typeof createClosureActions> &
  ReturnType<typeof createPreparationActions> & {
    submitRecoveryAction(input: SubmitRecoveryAction): Promise<string>;
    resolveRecoveryAction(
      input: ResolveRecoveryAction,
    ): Promise<'confirmed' | 'failed' | 'unknown'>;
    close(): Promise<void>;
  };
/** This unintegrated v1 journal has no migration to later experimental formats. */
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
    submitRecoveryAction: (input: SubmitRecoveryAction) =>
      submitRecoveryAction(store, input),
    resolveRecoveryAction: (input: ResolveRecoveryAction) =>
      resolveRecoveryAction(store, input),
    close: store.close,
  };
}
