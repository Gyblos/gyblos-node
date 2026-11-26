import { COLLECTOR_URL } from './config';
import { ALL_TIME, RANGE, UNITS } from './constants';
import { fetchJson } from './fetch-json';
import { rangeQuery, type RangeDays } from './range';
import { record, SourceShapeError } from './validate';

const utcDay = (time: number) =>
  new Date(time).toISOString().slice(0, RANGE.dayPrecision);

export function inclusiveDates(from: string, to: string) {
  const first = Date.parse(from);
  const last = Date.parse(to);
  const dates: string[] = [];
  for (let date = first; date <= last; date += UNITS.msPerDay)
    dates.push(utcDay(date));
  return dates;
}

export async function readStats(
  resource: string,
  days: RangeDays,
  end: number,
  periodsBack = 0,
) {
  if (days === ALL_TIME && periodsBack !== 0)
    throw new RangeError('All time has no previous period');
  const to = utcDay(end);
  const query =
    days === ALL_TIME
      ? `?range=${ALL_TIME}&to=${to}`
      : rangeQuery(days, end, periodsBack);
  const body = record(
    await fetchJson(`${COLLECTOR_URL}/stats/${resource}${query}`, resource),
    resource,
  );
  if (days !== ALL_TIME && (body.from !== undefined || body.to !== undefined)) {
    const bounds = new URLSearchParams(query);
    if (body.from !== bounds.get('from') || body.to !== bounds.get('to'))
      throw new SourceShapeError('Unexpected stats window');
  }
  if (
    days === ALL_TIME &&
    (body.range !== ALL_TIME ||
      typeof body.historyAvailable !== 'boolean' ||
      body.to !== to ||
      typeof body.from !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.from) ||
      body.from > to ||
      !Number.isFinite(Date.parse(body.from)) ||
      utcDay(Date.parse(body.from)) !== body.from ||
      (!body.historyAvailable && body.from !== body.to))
  ) {
    throw new SourceShapeError('All-time history unavailable');
  }
  return body;
}
