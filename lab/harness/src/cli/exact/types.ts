// Shared context and provider types for the exact-gate modules.
import type { SupportedResponse } from '@x402/core/types';

import {
  type AuditedPublicFacilitator,
  type createExactSeller,
} from '../../exact/seller.js';
import type { ExactGateEvidence } from '../../types.js';
import { type Config } from '../../wallet.js';
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
