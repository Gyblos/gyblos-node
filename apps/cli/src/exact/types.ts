import type { SupportedResponse } from '@x402/core/types';

import type { Config } from '@gyblos/lab-harness/config';
import type { ExactGateEvidence } from '@gyblos/lab-harness/types';
import type {
  AuditedPublicFacilitator,
  createExactSeller,
} from '@gyblos/seller/exact';

import type { authorizationMetadata } from './reconcile.js';

export interface ExactProvider {
  url: string;
  feePayer: string;
  supported: SupportedResponse;
}

export interface ExactContext {
  config: Config;
  provider: ExactProvider;
  host: Awaited<ReturnType<typeof createExactSeller>>;
  facilitator: AuditedPublicFacilitator;
  url: string;
  evidence: ExactGateEvidence;
  persist: () => Promise<void>;
  journalPath: string;
  evidencePath: string;
}

export type ActiveAuthorization = ReturnType<typeof authorizationMetadata> & {
  buyer: string;
};
