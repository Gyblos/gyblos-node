import type {
  AuthorizationMetadata,
  ExactSnapshot,
  Reconciliation,
} from './evidence-types.js';

export interface JournalStateRecord {
  state?: string;
}

export type AuthorizationJournal = {
  state: 'authorization-created';
  createdAt: string;
} & (
  | { channelId: string; asset: string; network: string; ceiling: string }
  | { channelId: string; case: 'F1' | 'F2' }
  | {
      requestId: string;
      channelId: string;
      ceilingAtomic: string;
      network: string;
      mint: string;
    }
  | (AuthorizationMetadata & {
      case: string;
      facilitator: string;
      buyer: string;
      before: ExactSnapshot;
    })
);

export interface InferenceJournal {
  state: 'reconciled' | 'verified';
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
  | { state: 'verified'; evidencePath: string; channelId: string }
  | {
      state: 'resolved-rejected';
      channelId: string;
      resolvedAt: string;
      resultPath: string;
    }
  | (AuthorizationMetadata & {
      state: 'rejected';
      reconciliation: Reconciliation;
    })
  | (AuthorizationMetadata & { state: 'confirmed'; transaction: string })
  | (AuthorizationMetadata & {
      state: 'uncertain';
      buyer: string;
      reconciliation: Reconciliation;
    });
