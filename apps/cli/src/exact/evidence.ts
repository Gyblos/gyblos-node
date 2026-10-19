import { X402_SDK_VERSION } from '@gyblos/config';
import type { GateEvidence } from '@gyblos/gate/types';
import { DEVNET, DEVNET_USDC } from '@gyblos/payments-x402/constants';
import { EXACT_PRICE } from '@gyblos/payments-x402/exact/index';

export function createEvidence() {
  const limitations = [
    'exact charges a fixed price, without usage metering or unused-ceiling refunds',
    'Does not validate upto, MPP, inference, Iroh or correctness of delivered content; REV-13 remains open',
    'Depends on third-party availability',
    'Replay guard is process-scoped; restart/distributed replay protection is not validated',
  ];
  const evidence: GateEvidence = {
    schemaVersion: 1,
    evidenceId: 'GYB-GATE-0004',
    sdkVersion: X402_SDK_VERSION,
    network: DEVNET,
    mint: DEVNET_USDC,
    assetLabel: 'Circle devnet USDC',
    priceAtomic: EXACT_PRICE,
    status: 'in-progress',
    gatePassed: false,
    startedAt: new Date().toISOString(),
    facilitators: [],
    results: [],
    limitations,
  };
  return evidence;
}
