import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import { COLLECTOR_LIMITERS } from '@gyblos/metrics-collector/constants';
import type { ChainTxPage } from '@gyblos/metrics-collector/stats-chain-txs';
import { chainTxReader } from '@gyblos/metrics-collector/stats-chain-txs-read';
import { statsReader } from '@gyblos/metrics-collector/stats-read';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';

import { fakeLimiter } from './metrics-collector';
import type { SqliteD1 } from './metrics-collector-d1';

export const ORIGIN = 'https://collector.test';
const ROUTE = '/v1/stats/chain/txs';
export const sig = (label: string) => label.padEnd(87, 'z');

export function collector(
  database: SqliteD1,
  options: { withReader?: boolean; read?: boolean } = {},
) {
  const read = fakeLimiter(options.read ?? true);
  const ip = fakeLimiter();
  const app = createMetricsCollector({
    storage: createD1Storage(database),
    stats: statsReader(database),
    ...(options.withReader === false
      ? {}
      : { chainTransactions: chainTxReader(database) }),
    limiters: {
      [COLLECTOR_LIMITERS.IP]: ip,
      [COLLECTOR_LIMITERS.NODE]: fakeLimiter(),
      [COLLECTOR_LIMITERS.GLOBAL]: fakeLimiter(),
      [COLLECTOR_LIMITERS.READ]: read,
    },
    now: () => Date.UTC(2026, 10, 20),
  });
  return { app, read, ip };
}
export async function get(
  app: ReturnType<typeof collector>['app'],
  query = '',
) {
  const response = await app.request(`${ORIGIN}${ROUTE}${query}`);
  return {
    status: response.status,
    cache: response.headers.get('Cache-Control'),
    body: (await response.json()) as ChainTxPage & { error?: string },
  };
}

export const summary = (rows: ChainTxPage['transactions']) =>
  rows.map((row) => [
    row.signature,
    row.instructionIndex,
    row.kind,
    row.channel,
    row.amountAtomic,
  ]);
