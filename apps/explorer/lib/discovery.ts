// Owns the read of the discovery index: models offered now, sellers online and their uptime, and the
// network status of every registered seller, fetched, checked at the boundary on each render.

import { cache } from 'react';

import { DISCOVERY_URL } from './config';
import { DISCOVERY } from './constants';
import { fetchJson } from './fetch-json';
import { parseNetworkStatus, type NetworkStatus } from './network-status';
import { list, nullable, num, record, text } from './validate';

export interface OfferedModel {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  contextTokens: number;
  pricing: { inputAtomicPerMtok: string; outputAtomicPerMtok: string };
}
export interface Uptime {
  firstSeenAt: number;
  windows: { days: number; ratio: number }[];
}
export interface Seller {
  nodeId: string;
  owner: string;
  models: OfferedModel[];
  uptime: Uptime | null;
}
export interface DiscoverySnapshot {
  generatedAt: number;
  sellers: Seller[];
  // Null when the index does not answer /network (an older index): only online sellers are known.
  network: NetworkStatus | null;
  // True when this render stopped at one of DISCOVERY's read bounds: sellers or uptimes may be missing.
  truncated: boolean;
  error: string | null;
}

const read = (path: string) =>
  fetchJson(`${DISCOVERY_URL}${path}`, `discovery ${path}`);

function offeredModel(value: unknown): OfferedModel {
  const source = record(value, 'model');
  const pricing = record(source.pricing, 'model.pricing');
  const optional = (field: unknown, where: string) =>
    nullable(field, (present) => text(present, where));
  return {
    modelId: text(source.modelId, 'model.modelId'),
    variant: optional(source.variant, 'model.variant'),
    quantization: optional(source.quantization, 'model.quantization'),
    contextTokens: num(source.contextTokens, 'model.contextTokens'),
    pricing: {
      inputAtomicPerMtok: text(pricing.inputAtomicPerMtok, 'pricing.input'),
      outputAtomicPerMtok: text(pricing.outputAtomicPerMtok, 'pricing.output'),
    },
  };
}
function uptime(value: unknown): Uptime {
  const source = record(value, 'uptime');
  return {
    firstSeenAt: num(source.firstSeenAt, 'uptime.firstSeenAt'),
    windows: list(source.windows, 'uptime.windows').map((entry) => {
      const window = record(entry, 'uptime.window');
      return {
        days: num(window.days, 'window.days'),
        ratio: num(window.ratio, 'window.ratio'),
      };
    }),
  };
}

// Every seller offering any listed model, from the paged /sellers answers, within DISCOVERY.maxSellerPages
// pages in all; `truncated` when a page was left unread.
async function sellersOf(
  modelIds: string[],
): Promise<{ byNode: Map<string, Seller>; truncated: boolean }> {
  const byNode = new Map<string, Seller>();
  let pages = 0;
  for (const modelId of modelIds) {
    let cursor: string | null = null;
    do {
      if (pages >= DISCOVERY.maxSellerPages) return { byNode, truncated: true };
      pages += 1;
      const query = new URLSearchParams({ model: modelId });
      if (cursor) query.set('cursor', cursor);
      const page = record(await read(`/sellers?${query}`), 'sellers page');
      for (const entry of list(page.sellers, 'sellers')) {
        const catalog = record(record(entry, 'seller').catalog, 'catalog');
        const signed = record(catalog.record, 'catalog.record');
        const nodeId = text(signed.nodeId, 'record.nodeId');
        if (!byNode.has(nodeId))
          byNode.set(nodeId, {
            nodeId,
            owner: text(signed.owner, 'record.owner'),
            models: list(signed.models, 'record.models').map(offeredModel),
            uptime: null,
          });
      }
      cursor = nullable(page.next, (present) => text(present, 'next'));
    } while (cursor);
  }
  return { byNode, truncated: false };
}

// Live view of the discovery index: models offered now, sellers online and their uptime. Read once per
// render: the Network and Models sections share the answer.
export const getDiscovery = cache(async (): Promise<DiscoverySnapshot> => {
  try {
    return await loadDiscovery();
  } catch (error) {
    return {
      generatedAt: 0,
      sellers: [],
      network: null,
      truncated: false,
      error: error instanceof Error ? error.message : 'discovery unavailable',
    };
  }
});

// Throws on failure. A seller whose uptime cannot be read shows none for this render.
async function loadDiscovery(): Promise<DiscoverySnapshot> {
  const listed = record(await read('/models'), 'models');
  const modelIds = list(listed.models, 'models.models').map((entry) =>
    text(record(entry, 'models.model').id, 'model.id'),
  );
  const found = await sellersOf(modelIds);
  const sellers = [...found.byNode.values()];
  const network = read('/network').then(parseNetworkStatus, () => null);
  await Promise.all(
    sellers.slice(0, DISCOVERY.maxUptimeReads).map(async (seller) => {
      try {
        seller.uptime = uptime(
          await read(`/uptime?node=${encodeURIComponent(seller.nodeId)}`),
        );
      } catch {
        seller.uptime = null;
      }
    }),
  );
  return {
    generatedAt: num(listed.generatedAt, 'models.generatedAt'),
    sellers,
    network: await network,
    truncated: found.truncated || sellers.length > DISCOVERY.maxUptimeReads,
    error: null,
  };
}
