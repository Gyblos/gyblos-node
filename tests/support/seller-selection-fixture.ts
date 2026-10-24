// Owns synthetic seller-selection records, a seeded RNG and result helpers; no keys or signatures.
import assert from 'node:assert/strict';

import { SELLER_BADGES } from '@gyblos/core/constants';
import {
  selectSellers,
  type KnownSeller,
  type SellerRequest,
  type SellerSelectionInput,
  type SellerStats,
} from '@gyblos/core/seller-selection';
import {
  CONTROL_RECORD_VERSION,
  DATA_RETENTION,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_PRICE_UNIT,
  PUBLIC_RECORD_KINDS,
  REASONING_LEVELS,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';

export const NOW = 1_800_000_000_000;
export const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const ASSET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const MODEL = {
  modelId: 'qwen3-0.6b',
  variant: null,
  quantization: 'q4_k_m',
};
const { OFF, HIGH } = REASONING_LEVELS;

interface SellerOptions {
  owner?: string;
  input?: string;
  output?: string;
  reasoning?: ReasoningLevel[];
  modelId?: string;
  retention?: KnownSeller['catalog']['dataPolicy']['retention'];
  badge?: KnownSeller['badge'];
  openChannel?: boolean;
  presence?: 'fresh' | 'stale' | 'none';
  catalogExpired?: boolean;
  withdrawn?: boolean;
}
export const nodeId = (index: number) => index.toString(16).padStart(64, '0');
export function seller(
  index: number,
  options: SellerOptions = {},
): KnownSeller {
  const header: Pick<
    KnownSeller['catalog'],
    'schemaVersion' | 'owner' | 'nodeId' | 'issuedAt'
  > = {
    schemaVersion: CONTROL_RECORD_VERSION,
    owner: options.owner ?? `Owner${index}`,
    nodeId: nodeId(index),
    issuedAt: NOW - 1000,
  };
  const catalog: KnownSeller['catalog'] = {
    ...header,
    kind: PUBLIC_RECORD_KINDS.CATALOG,
    sequence: 1,
    expiresAt: options.catalogExpired ? NOW : NOW + 60_000,
    dataPolicy: { retention: options.retention ?? DATA_RETENTION.NONE },
    models: [
      {
        ...MODEL,
        modelId: options.modelId ?? MODEL.modelId,
        contextTokens: 4096,
        pricing: {
          network: NETWORK,
          asset: ASSET,
          unit: PUBLIC_PRICE_UNIT,
          inputAtomic: options.input ?? '1',
          outputAtomic: options.output ?? '2',
        },
        reasoning: options.reasoning ?? [OFF, HIGH],
      },
    ],
  };
  const presence: KnownSeller['presence'] =
    options.presence === 'none'
      ? null
      : {
          ...header,
          kind: PUBLIC_RECORD_KINDS.PRESENCE,
          sequence: 2,
          issuedAt: options.presence === 'stale' ? NOW - 90_000 : NOW - 500,
          expiresAt: options.presence === 'stale' ? NOW : NOW + 60_000,
          catalogDigest: 'a'.repeat(64),
          state: PUBLIC_PRESENCE_STATE,
        };
  const withdrawal: KnownSeller['withdrawal'] = options.withdrawn
    ? {
        ...header,
        kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
        sequence: 3,
        expiresAt: NOW + 60_000,
        catalogDigest: 'a'.repeat(64),
      }
    : null;
  return {
    catalog,
    presence,
    withdrawal,
    badge: options.badge ?? SELLER_BADGES.MEASURABLE_USAGE,
    openChannel: options.openChannel ?? false,
  };
}
export function request(overrides: Partial<SellerRequest> = {}): SellerRequest {
  return {
    selection: MODEL,
    reasoning: HIGH,
    lowestReasoning: null,
    network: NETWORK,
    asset: ASSET,
    maxTokens: 100,
    priceCeilings: { inputAtomic: '100', outputAtomic: '100' },
    maxAtomic: '1000',
    minimumBadge: SELLER_BADGES.DECLARED_USAGE,
    retention: [DATA_RETENTION.NONE],
    ...overrides,
  };
}
// Mulberry32: a small deterministic generator for reproducible sampling tests.
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
export const history = (overrides: Partial<SellerStats> = {}): SellerStats => ({
  successes: 5,
  failures: 0,
  latencyMs: 1000,
  waitAccuracy: 1,
  cooldownUntil: null,
  ...overrides,
});
export function select(
  sellers: KnownSeller[],
  overrides: Partial<SellerSelectionInput> = {},
) {
  return selectSellers({
    request: request(),
    sellers,
    stats: new Map(),
    now: NOW,
    random: seeded(1),
    ...overrides,
  });
}
export function chosen(result: ReturnType<typeof selectSellers>) {
  assert.equal(result.ok, true);
  return result.ok ? result.candidates : [];
}
export function frequency(runs: number, run: (seed: number) => string[]) {
  const counts = new Map<string, number>();
  for (let seed = 1; seed <= runs; seed++)
    for (const id of run(seed)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}
