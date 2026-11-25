import { and, sql, type SQLWrapper } from 'drizzle-orm';

import { payoutTransactions } from './aggregate-chain';
import { headlineReceipt } from './aggregate-sql';
import { AGGREGATES, CHAIN_AGGREGATE_SCOPES } from './constants';
import type { CollectorDatabase } from './d1-client';
import { dayBounds } from './days';
import { receipts } from './schema';
import { inRange, number, total } from './sql-primitives';
import type { IntradayBounds, IntradayRow } from './stats-store';

export function intradayBounds(url: URL, now: number): IntradayBounds | null {
  const params = url.searchParams;
  const from = dayBounds(params.get('from') ?? '');
  const to = dayBounds(params.get('to') ?? '');
  if (
    !from ||
    !to ||
    url.search !== `?from=${from.day}&to=${to.day}` ||
    to.end > now ||
    from.start >= to.end ||
    to.end - from.start > AGGREGATES.maxIntradayDays * AGGREGATES.dayMs
  )
    return null;
  return { start: from.start, end: to.end };
}

const halfHour = (at: SQLWrapper) =>
  sql<number>`(${at} - ${at} % ${number(AGGREGATES.halfHourMs)})`;

export async function intradayRows(
  orm: CollectorDatabase,
  bounds: IntradayBounds,
): Promise<IntradayRow[]> {
  const receiptTime = halfHour(receipts.sellerReceivedAt);
  const payoutTime = halfHour(sql.identifier('at'));
  const { perTx, shown } = payoutTransactions(
    bounds,
    CHAIN_AGGREGATE_SCOPES.GYBLOS,
  );
  const [usage, payouts] = await orm.batch([
    orm
      .select({
        at: receiptTime,
        tokens: total(sql`${receipts.inputTokens} + ${receipts.outputTokens}`),
        requests: sql<number>`count(*)`,
      })
      .from(receipts)
      .where(and(inRange(receipts.sellerReceivedAt, bounds), headlineReceipt))
      .groupBy(receiptTime),
    orm
      .select({ at: payoutTime, paidOut: shown('o').mapWith(String) })
      .from(perTx)
      .groupBy(payoutTime),
  ]);
  const rows = new Map<number, IntradayRow>(
    usage.map((row) => [row.at, { ...row, paidOut: '0' }]),
  );
  for (const { at, paidOut } of payouts) {
    if (paidOut === '0') continue;
    const existing = rows.get(at);
    if (existing) existing.paidOut = paidOut;
    else rows.set(at, { at, requests: 0, tokens: 0, paidOut });
  }
  return [...rows.values()].sort((left, right) => left.at - right.at);
}
