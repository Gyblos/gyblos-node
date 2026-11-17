// Owns the read of the discovery index: models offered now, sellers online and their uptime.
import { cacheLife } from 'next/cache';

import { DISCOVERY_URL } from './config';
import { CACHE_LIFE, DISCOVERY } from './constants';

export interface OfferedModel {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  contextTokens: number;
  reasoning: string[];
  pricing: {
    network: string;
    asset: string;
    unit: string;
    inputAtomicPerMtok: string;
    outputAtomicPerMtok: string;
  };
}

export interface Seller {
  nodeId: string;
  owner: string;
  issuedAt: number;
  expiresAt: number;
  models: OfferedModel[];
  uptime: Uptime | null;
}

export interface Uptime {
  firstSeenAt: number;
  lastSeenAt: number;
  windows: { days: number; seen: number; slots: number; ratio: number }[];
}

export interface DiscoverySnapshot {
  generatedAt: number;
  models: { id: string; sellers: number }[];
  sellers: Seller[];
  error: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DISCOVERY_URL}${path}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error(`discovery ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

interface SellersPage {
  sellers: {
    catalog: { record: Omit<Seller, 'uptime'> & { models: OfferedModel[] } };
  }[];
  next: string | null;
}

// Live view of the discovery index: models offered now, sellers online and their uptime.
export async function getDiscovery(): Promise<DiscoverySnapshot> {
  try {
    return await loadDiscovery();
  } catch (error) {
    return {
      generatedAt: 0,
      models: [],
      sellers: [],
      error: error instanceof Error ? error.message : 'discovery unavailable',
    };
  }
}

// Throws on failure so an error is never stored in the cache.
async function loadDiscovery(): Promise<DiscoverySnapshot> {
  'use cache';
  cacheLife(CACHE_LIFE.discovery);
  {
    const { models, generatedAt } = await getJson<{
      models: { id: string; sellers: number }[];
      generatedAt: number;
    }>('/models');

    const byNode = new Map<string, Seller>();
    for (const model of models) {
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = new URLSearchParams({ model: model.id });
        if (cursor) query.set('cursor', cursor);
        const page: SellersPage = await getJson<SellersPage>(
          `/sellers?${query}`,
        );
        for (const entry of page.sellers) {
          const record = entry.catalog.record;
          if (!byNode.has(record.nodeId)) {
            byNode.set(record.nodeId, {
              nodeId: record.nodeId,
              owner: record.owner,
              issuedAt: record.issuedAt,
              expiresAt: record.expiresAt,
              models: record.models,
              uptime: null,
            });
          }
        }
        cursor = page.next;
        pages += 1;
      } while (cursor && pages < DISCOVERY.maxSellerPages);
    }

    const sellers = [...byNode.values()];
    await Promise.all(
      sellers.map(async (seller) => {
        try {
          seller.uptime = await getJson<Uptime>(
            `/uptime?node=${encodeURIComponent(seller.nodeId)}`,
          );
        } catch {
          seller.uptime = null;
        }
      }),
    );

    return { generatedAt, models, sellers, error: null };
  }
}
