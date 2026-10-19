import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';

import type { TokenCounts } from '@gyblos/application/metering';
import { LOCAL_DIR, localPath } from '@gyblos/config';
import { MODEL } from '@gyblos/inference-ollama/model';

export interface MeasurementInput {
  requestId: string;
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
  anomaly: string;
  responseText: string;
}

export function measurementRow(input: MeasurementInput, salt: Uint8Array) {
  const validLatency = Number.isFinite(input.latencyMs) && input.latencyMs > 0;
  // Explicit allowlist: never spread a response, request, exception or arbitrary metadata.
  const copyCounts = (counts: TokenCounts) => ({
    input: counts.input,
    output: counts.output,
  });
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    requestId: input.requestId,
    seller: input.seller,
    offer: input.offer,
    model: { name: MODEL.name, digest: MODEL.digest },
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
        ? input.recountedTokens.output / (input.latencyMs / 1000)
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
export type Measurement = ReturnType<typeof measurementRow>;

export async function measurementSalt(directory = LOCAL_DIR) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = `${directory}/measurement-salt`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(randomBytes(32));
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
  if (salt.length !== 32) throw new Error('Invalid local measurement salt.');
  return salt;
}
export async function appendMeasurement(
  row: Measurement,
  path = localPath('measurements.jsonl'),
) {
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.writeFile(JSON.stringify(row) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
