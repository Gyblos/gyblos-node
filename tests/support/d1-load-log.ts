import {
  D1_LOG_KINDS,
  explainD1Statement,
  type D1LogEntry,
  type SqliteD1,
} from './d1-sqlite';

export { D1_MAX_BOUND_PARAMETERS } from './metrics-collector-d1';

export const D1_LOAD_LABELS = {
  PUBLISH_CATALOG_1: 'publish.catalog1',
  PUBLISH_CATALOG_64: 'publish.catalog64',
  READ_NETWORK: 'read.network',
  READ_MODELS: 'read.models',
  READ_OFFER_HISTORY: 'read.offerHistory',
  READ_NETWORK_HISTORY: 'read.networkHistory',
  CRON_ROLLUP: 'cron.rollup',
  AGG_DAY_1: 'agg.day1',
  AGG_DAYS_31: 'agg.days31',
} as const;
export type D1LoadLabel = (typeof D1_LOAD_LABELS)[keyof typeof D1_LOAD_LABELS];

export interface D1LoadRow {
  label: D1LoadLabel;
  statements: number;
  roundTrips: number;
  batches: number;
  maxParams: number;
  scans: number;
}

const FULL_SCAN = /^SCAN (?!CONSTANT ROW)/;

function summarizeD1Log(
  label: D1LoadLabel,
  entries: readonly D1LogEntry[],
  database: Pick<SqliteD1, 'raw'>,
): D1LoadRow {
  const batches = new Set(
    entries
      .filter((entry) => entry.kind === D1_LOG_KINDS.BATCH)
      .map((entry) => entry.batch),
  ).size;
  return {
    label,
    statements: entries.length,
    roundTrips:
      entries.filter((entry) => entry.kind === D1_LOG_KINDS.DIRECT).length +
      batches,
    batches,
    maxParams: Math.max(0, ...entries.map((entry) => entry.params.length)),
    scans: entries.filter((entry) =>
      explainD1Statement(database, entry).some((row) =>
        FULL_SCAN.test(row.detail),
      ),
    ).length,
  };
}

export async function measureD1Step(
  label: D1LoadLabel,
  database: Pick<SqliteD1, 'raw' | 'log'>,
  action: () => Promise<unknown>,
) {
  database.log.length = 0;
  await action();
  return summarizeD1Log(label, [...database.log], database);
}
