import { COLLECTOR_URL } from './config';
import { fetchJson } from './fetch-json';
import type { HalfHour } from './period-bars';
import { integerText, list, num, record } from './validate';

export async function readHalfHours(dates: string[]): Promise<HalfHour[]> {
  if (!dates.length) return [];
  const query = new URLSearchParams({ from: dates[0]!, to: dates.at(-1)! });
  try {
    const preview =
      process.env.NODE_ENV === 'development' &&
      process.env.GYBLOS_PREVIEW_HALF_HOURS;
    const rows: unknown = preview
      ? JSON.parse(preview)
      : record(
          await fetchJson(
            `${COLLECTOR_URL}/stats/intraday?${query}`,
            'intraday',
          ),
          'intraday',
        ).rows;
    return list(rows, 'half hours').map((value) => {
      const row = record(value, 'interval');
      return {
        at: num(row.at, 'start'),
        tokens: num(row.tokens, 'tokens'),
        requests: num(row.requests, 'requests'),
        paidOut: BigInt(integerText(row.paidOut, 'payout')),
      };
    });
  } catch {
    return [];
  }
}
