import type { DEVNET } from '@gyblos/config';
import type {
  ExactCaseName,
  FAILURE_CASES,
  JOURNAL_STATES,
} from '@gyblos/lab-harness/constants';

import type {
  AuthorizationMetadata,
  ExactSnapshot,
  Reconciliation,
} from './evidence-types.js';

// Historical input stays open: unknown states must continue to block new payments.
export interface JournalStateRecord {
  state?: string;
}

export type AuthorizationJournal = {
  state: typeof JOURNAL_STATES.AUTHORIZATION_CREATED;
  createdAt: string;
} & (
  | {
      channelId: string;
      asset: string;
      network: typeof DEVNET;
      ceiling: string;
    }
  | {
      channelId: string;
      case: typeof FAILURE_CASES.EMPTY_BUYER | typeof FAILURE_CASES.EXPIRED;
    }
  | {
      requestId: string;
      channelId: string;
      ceilingAtomic: string;
      network: typeof DEVNET;
      mint: string;
    }
  | (AuthorizationMetadata & {
      case: ExactCaseName;
      facilitator: string;
      buyer: string;
      before: ExactSnapshot;
    })
);

export interface InferenceJournal {
  state: typeof JOURNAL_STATES.RECONCILED | typeof JOURNAL_STATES.VERIFIED;
  requestId: string;
  channelId: string;
  depositSignature: string;
  claimSignature: string;
  chargedAtomic: string;
  evidencePath: string;
}

export type GateJournalRecord =
  | AuthorizationJournal
  | InferenceJournal
  | {
      state: typeof JOURNAL_STATES.VERIFIED;
      evidencePath: string;
      channelId: string;
    }
  | {
      state: typeof JOURNAL_STATES.RESOLVED_REJECTED;
      channelId: string;
      resolvedAt: string;
      resultPath: string;
    }
  | (AuthorizationMetadata & {
      state: typeof JOURNAL_STATES.REJECTED;
      reconciliation: Reconciliation;
    })
  | (AuthorizationMetadata & {
      state: typeof JOURNAL_STATES.CONFIRMED;
      transaction: string;
    })
  | (AuthorizationMetadata & {
      state: typeof JOURNAL_STATES.UNCERTAIN;
      buyer: string;
      reconciliation: Reconciliation;
    });
