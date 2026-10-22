import { readFile } from 'node:fs/promises';

import { X402_SDK_VERSION } from '@gyblos/config';
import { PRICES, TOLERANCE } from '@gyblos/core/metering';
import { MODEL } from '@gyblos/engine-ollama';
import { GENERATION } from '@gyblos/engine-ollama/constants';
import { DEVNET } from '@gyblos/payments-x402/constants';

import { saveJson, type Config } from '../../config.js';
import {
  EVIDENCE_IDS,
  EVIDENCE_STATUSES,
  SCHEMA_VERSIONS,
} from '../../constants.js';
import type { InferenceGateEvidence } from '../../types.js';

export async function initializeEvidence(
  config: Config,
  runId: string,
  evidencePath: string,
) {
  const evidence: InferenceGateEvidence = {
    schemaVersion: SCHEMA_VERSIONS.EVIDENCE,
    evidenceId: EVIDENCE_IDS.INFERENCE,
    sdkVersion: X402_SDK_VERSION,
    createdAt: new Date().toISOString(),
    runId,
    network: DEVNET,
    mint: config.mint,
    assetLabel: config.assetLabel,
    model: MODEL,
    prices: PRICES,
    tolerance: TOLERANCE,
    template: {
      raw: true,
      thinking: false,
      numCtx: GENERATION.numCtx,
      seed: GENERATION.seed,
      temperature: GENERATION.temperature,
      outputCountConvention:
        'Visible raw output only; terminal EOS is not added. Differences remain explicit under predeclared tolerance.',
    },
    status: EVIDENCE_STATUSES.IN_PROGRESS,
    gatePassed: false,
    results: [],
    limitations: [
      'Measurements are local buyer declarations without a signed seller receipt',
      'No buyer-facing streaming or first-word latency; effective TPS includes payment and settlement',
      'Does not validate the model (LOGIC), MPP, Iroh, reputation scores or penalties',
      'Uses an explicitly labeled devnet asset, never mainnet',
      'In-memory facilitator; uncertain outcomes require manual on-chain reconciliation',
      'Detecting within-ceiling overcharge does not prevent or refund it; REV-13 remains open',
      'Only the pinned single-user no-tools chat template branch is supported',
    ],
  };
  try {
    const previous = JSON.parse(await readFile(evidencePath, 'utf8'));
    evidence.previousAttempts = [
      ...(previous.previousAttempts ?? []),
      { ...previous, previousAttempts: undefined },
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await saveJson(evidencePath, evidence);
  return evidence;
}
