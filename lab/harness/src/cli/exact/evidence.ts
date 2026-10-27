// Builds the initial in-progress GYB-GATE-0004 (exact, Circle devnet USDC) evidence record and its
// declared limitations.
import { DEVNET, DEVNET_USDC, X402_SDK_VERSION } from '@gyblos/config';

import {
  EVIDENCE_IDS,
  EVIDENCE_STATUSES,
  EXACT_ASSET_LABELS,
  EXACT_PRICE,
  SCHEMA_VERSIONS,
} from '../../constants';
import type { ExactGateEvidence } from '../../types';

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
