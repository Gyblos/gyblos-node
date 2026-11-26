import assert from 'node:assert/strict';

import type {
  PublicCatalogV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';

import {
  MODEL,
  T0,
  type IndexHarness,
  type IndexNode,
} from './discovery-index-fixture';

export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const HISTORY = '/v1/offers/history';

export function priced(
  node: IndexNode,
  sequence: number,
  output: string,
  {
    models = [MODEL],
    issuedAt = T0,
  }: { models?: string[]; issuedAt?: number } = {},
): SignedPublicV2 {
  const record = structuredClone(
    node.catalog(sequence, { models, issuedAt }).record,
  ) as PublicCatalogV2;
  for (const model of record.models) model.pricing.outputAtomicPerMtok = output;
  return node.sign(record);
}

export async function history(harness: IndexHarness, query: string) {
  const response = await harness.call(`${HISTORY}?${query}`);
  assert.equal(response.status, 200);
  return (await response.json()) as {
    periods: {
      nodeId: string;
      owner: string;
      firstSequence: number;
      startedAt: number;
      lastPublishedAt: number;
      expiresAt: number;
      endedAt: number | null;
      endReason: string | null;
      offers: {
        modelId: string;
        variant: string | null;
        quantization: string | null;
        contextTokens: number;
        reasoning: string[];
        pricing: Record<string, string>;
      }[];
    }[];
    truncated: boolean;
  };
}

export async function accepted(harness: IndexHarness, signed: unknown) {
  const response = await harness.publish(signed);
  assert.equal(response.status, 201, await response.text());
}
