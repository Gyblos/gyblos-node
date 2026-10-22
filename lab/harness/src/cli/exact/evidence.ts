import { X402_SDK_VERSION } from '@gyblos/config';
import { EXACT_PRICE } from '@gyblos/core/constants';
import { DEVNET, DEVNET_USDC } from '@gyblos/payments-x402/constants';

import {
  EVIDENCE_IDS,
  EVIDENCE_STATUSES,
  EXACT_ASSET_LABELS,
  SCHEMA_VERSIONS,
} from '../../constants.js';
import type { ExactGateEvidence } from '../../types.js';

export function createEvidence() {
  const limitations = [
    'exact charges a fixed price, without usage metering or unused-ceiling refunds',
    'Does not validate upto, MPP, inference, Iroh or correctness of delivered content; REV-13 remains open',
    'Depends on third-party availability',
    'Replay guard is process-scoped; restart/distributed replay protection is not validated',
  ];
  const evidence: ExactGateEvidence = {
    schemaVersion: SCHEMA_VERSIONS.EVIDENCE,
    evidenceId: EVIDENCE_IDS.EXACT,
    sdkVersion: X402_SDK_VERSION,
    network: DEVNET,
    mint: DEVNET_USDC,
    assetLabel: EXACT_ASSET_LABELS.CIRCLE_USDC,
    priceAtomic: EXACT_PRICE,
    status: EVIDENCE_STATUSES.IN_PROGRESS,
    gatePassed: false,
    startedAt: new Date().toISOString(),
    facilitators: [],
    results: [],
    limitations,
  };
  return evidence;
}
