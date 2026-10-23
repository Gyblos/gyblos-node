// Builds allowlisted measurement rows (with a salted response hash) and appends them to a private JSONL file.
// Never copies responses, prompts or error text into a row.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { FILE_MODES, KEY_LIMITS, ROLE_FILES, UNITS } from '@gyblos/config';
import type { ChargeAnomaly } from '@gyblos/core/constants';
import type { TokenCounts } from '@gyblos/core/metering';
import { MODEL } from '@gyblos/engine-ollama/model';
import { type EngineDescription } from '@gyblos/protocol/engine';

import { MEASUREMENT_SCHEMA_VERSION } from './constants.js';

export interface MeasurementInput {
  requestId: string;
  model?: Pick<Required<EngineDescription>, 'name' | 'digest'>;
  seller: string;
  offer: string;
  channelId: string;
  depositSignature: string;
  claimSignature: string;
  ceilingAtomic: string;
  chargedAtomic: string;
  expectedAtomic: string;
  differenceAtomic: string;
  allowanceAtomic: string;
  relativeDifference: number | null;
  engineTokens: TokenCounts | null;
  billedTokens: TokenCounts | null;
  recountedTokens: TokenCounts;
  countComparison: {
    inputDelta: number;
    outputDelta: number;
    withinTolerance: boolean;
  } | null;
  latencyMs: number;
  delivered: boolean;
  anomaly: ChargeAnomaly;
  responseText: string;
  meteringMode?: 'recounted' | 'declared';
}

export type Measurement = ReturnType<typeof measurementRow>;

export function measurementRow(input: MeasurementInput, salt: Uint8Array) {
  const model = input.model ?? MODEL;
  const validLatency = Number.isFinite(input.latencyMs) && input.latencyMs > 0;
  // Explicit allowlist: never spread a response, request, exception or arbitrary metadata.
  const copyCounts = (counts: TokenCounts) => ({
    input: counts.input,
    output: counts.output,
  });
  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    meteringMode: input.meteringMode ?? 'recounted',
    recordedAt: new Date().toISOString(),
    requestId: input.requestId,
    seller: input.seller,
    offer: input.offer,
    model: { name: model.name, digest: model.digest },
    channelId: input.channelId,
    depositSignature: input.depositSignature,
    claimSignature: input.claimSignature,
    ceilingAtomic: input.ceilingAtomic,
    chargedAtomic: input.chargedAtomic,
    expectedAtomic: input.expectedAtomic,
    differenceAtomic: input.differenceAtomic,
    allowanceAtomic: input.allowanceAtomic,
    relativeDifference: input.relativeDifference,
    engineTokens: input.engineTokens ? copyCounts(input.engineTokens) : null,
    billedTokens: input.billedTokens ? copyCounts(input.billedTokens) : null,
    recountedTokens: copyCounts(input.recountedTokens),
    countComparison: input.countComparison
      ? {
          inputDelta: input.countComparison.inputDelta,
          outputDelta: input.countComparison.outputDelta,
          withinTolerance: input.countComparison.withinTolerance,
        }
      : null,
    latencyMs: validLatency ? input.latencyMs : null,
    effectiveTokensPerSecond:
      input.delivered && validLatency
        ? input.recountedTokens.output /
          (input.latencyMs / UNITS.millisecondsPerSecond)
        : null,
    firstWordMs: null,
    firstWordNote:
      'upto buffers the response until settlement; first-word latency is not observable',
    delivered: input.delivered,
    anomaly: input.anomaly,
    responseHash: createHash('sha256')
      .update(salt)
      .update(input.responseText)
      .digest('hex'),
    responseHashAlgorithm: 'sha256(salt || UTF-8 response)',
    sellerReceipt: null,
  };
}

// Callers pass their own private directory: the buyer role directory, or the lab home.
export async function measurementSalt(directory: string) {
  await mkdir(directory, {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  const path = join(directory, ROLE_FILES.measurementSalt);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', FILE_MODES.privateFile);
    try {
      await handle.writeFile(randomBytes(KEY_LIMITS.measurementSaltBytes));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Publish only complete bytes, exclusively: never replace another writer's salt.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  const salt = await readFile(path);
  if (salt.length !== KEY_LIMITS.measurementSaltBytes)
    throw new Error('Invalid local measurement salt.');
  return salt;
}

export async function appendMeasurement(row: Measurement, path: string) {
  const handle = await open(path, 'a', FILE_MODES.privateFile);
  try {
    await handle.writeFile(JSON.stringify(row) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
