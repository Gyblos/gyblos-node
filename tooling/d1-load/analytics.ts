import {
  D1_ANALYTICS,
  D1_ANALYTICS_ERRORS,
  type D1AnalyticsError,
} from './constants';

export interface AnalyticsWindow {
  start: string;
  end: string;
}

export interface AnalyticsTotals {
  readQueries: number;
  writeQueries: number;
  rowsRead: number;
  rowsWritten: number;
  p50Ms: number;
  p95Ms: number;
}

export interface DatabaseInfo {
  name: string;
  id: string;
  sizeBytes: number;
}

const fail = (code: D1AnalyticsError): never => {
  throw new Error(code);
};
const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
const count = (value: unknown, code: D1AnalyticsError) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fail(code);
const text = (value: unknown, code: D1AnalyticsError) =>
  typeof value === 'string' && value ? value : fail(code);
function json(raw: string, code: D1AnalyticsError): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fail(code);
  }
}

const isoDay = (time: number) =>
  new Date(time).toISOString().slice(0, D1_ANALYTICS.isoDayLength);

export function analyticsWindow(now: number): AnalyticsWindow {
  const today = Math.floor(now / D1_ANALYTICS.dayMs) * D1_ANALYTICS.dayMs;
  return {
    start: isoDay(today - D1_ANALYTICS.windowDays * D1_ANALYTICS.dayMs),
    end: isoDay(today - D1_ANALYTICS.dayMs),
  };
}

const QUERY = `query D1Load($accountTag: String!, $databaseIds: [String!]!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: ${D1_ANALYTICS.groupLimit}
        filter: { date_geq: $start, date_leq: $end, databaseId_in: $databaseIds }
      ) {
        dimensions { databaseId }
        sum { readQueries writeQueries rowsRead rowsWritten }
        quantiles { queryBatchTimeMsP50 queryBatchTimeMsP95 }
      }
    }
  }
}`;

export function analyticsRequest(
  accountTag: string,
  databaseIds: readonly string[],
  window: AnalyticsWindow,
) {
  return {
    query: QUERY,
    variables: { accountTag, databaseIds: [...databaseIds], ...window },
  };
}

export function parseAnalytics(body: unknown): Map<string, AnalyticsTotals> {
  const bad = D1_ANALYTICS_ERRORS.BAD_RESPONSE;
  const errors = field(body, 'errors');
  if (Array.isArray(errors) && errors.length) fail(bad);
  const accounts = field(field(field(body, 'data'), 'viewer'), 'accounts');
  const groups: unknown = Array.isArray(accounts)
    ? field(accounts[0], 'd1AnalyticsAdaptiveGroups')
    : undefined;
  if (!Array.isArray(groups)) return fail(bad);
  const totals = new Map<string, AnalyticsTotals>();
  for (const group of groups) {
    const sum = field(group, 'sum');
    const quantiles = field(group, 'quantiles');
    totals.set(text(field(field(group, 'dimensions'), 'databaseId'), bad), {
      readQueries: count(field(sum, 'readQueries'), bad),
      writeQueries: count(field(sum, 'writeQueries'), bad),
      rowsRead: count(field(sum, 'rowsRead'), bad),
      rowsWritten: count(field(sum, 'rowsWritten'), bad),
      p50Ms: count(field(quantiles, 'queryBatchTimeMsP50'), bad),
      p95Ms: count(field(quantiles, 'queryBatchTimeMsP95'), bad),
    });
  }
  return totals;
}

export function parseDatabaseInfo(raw: string) {
  const bad = D1_ANALYTICS_ERRORS.BAD_DATABASE_INFO;
  const info = json(raw, bad);
  return {
    id: text(field(info, 'uuid'), bad),
    sizeBytes: count(field(info, 'database_size'), bad),
  };
}

export const parseToken = (raw: string) =>
  text(
    field(json(raw, D1_ANALYTICS_ERRORS.NO_TOKEN), 'token'),
    D1_ANALYTICS_ERRORS.NO_TOKEN,
  );

export function parseAccountId(raw: string) {
  const accounts = field(json(raw, D1_ANALYTICS_ERRORS.NO_ACCOUNT), 'accounts');
  if (!Array.isArray(accounts) || accounts.length !== 1)
    return fail(D1_ANALYTICS_ERRORS.NO_ACCOUNT);
  return text(field(accounts[0], 'id'), D1_ANALYTICS_ERRORS.NO_ACCOUNT);
}

export function analyticsRows(
  databases: readonly DatabaseInfo[],
  totals: ReadonlyMap<string, AnalyticsTotals>,
): string[][] {
  return databases.map(({ name, id, sizeBytes }) => {
    const row = totals.get(id);
    const latency = (value: number | undefined) =>
      value === undefined ? '-' : value.toFixed(D1_ANALYTICS.latencyDigits);
    return [
      name,
      (sizeBytes / D1_ANALYTICS.bytesPerMegabyte).toFixed(
        D1_ANALYTICS.megabyteDigits,
      ),
      String(row?.readQueries ?? 0),
      String(row?.writeQueries ?? 0),
      String(row?.rowsRead ?? 0),
      String(row?.rowsWritten ?? 0),
      latency(row?.p50Ms),
      latency(row?.p95Ms),
    ];
  });
}

export function formatTable(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
  ].join('\n');
}
