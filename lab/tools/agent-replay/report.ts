import { HTTP_STATUS } from '@gyblos/config';

import type { ReplayTiming } from './client';
import { AGENT_REPLAY } from './constants';
import type { SellerTrace } from './network';

export type ReplayRecord = Omit<ReplayTiming, 'text'> & {
  sellerCount: number;
  sellers: number[];
  waitsMs: number[];
};

const round = (value: number) => Math.round(value);

function percentile(values: number[], rank: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return round(
    sorted[
      Math.min(
        sorted.length - 1,
        Math.ceil((rank / AGENT_REPLAY.percentScale) * sorted.length) - 1,
      )
    ]!,
  );
}

function spread(values: number[]) {
  return Object.fromEntries(
    AGENT_REPLAY.percentiles.map((rank) => [
      `p${rank}`,
      percentile(values, rank),
    ]),
  );
}

export function joinTraces(
  sellerCount: number,
  timings: ReplayTiming[],
  traces: Map<string, SellerTrace>,
): ReplayRecord[] {
  return timings.map(({ text: _text, ...timing }) => {
    const trace = traces.get(timing.tag);
    return {
      ...timing,
      sellerCount,
      sellers: trace?.sellers ?? [],
      waitsMs: (trace?.waitsMs ?? []).map(round),
    };
  });
}

export function summarize(records: ReplayRecord[]) {
  const served = records.filter(
    (record) =>
      record.status === HTTP_STATUS.ok && record.firstTokenMs !== null,
  );
  const failures: Record<string, number> = {};
  for (const record of records)
    if (record.status !== HTTP_STATUS.ok || record.firstTokenMs === null) {
      const key = `${record.status}:${record.code ?? 'none'}`;
      failures[key] = (failures[key] ?? 0) + 1;
    }
  const bySeller: Record<string, number> = {};
  for (const record of served) {
    const seller = String(record.sellers.at(-1) ?? 0);
    bySeller[seller] = (bySeller[seller] ?? 0) + 1;
  }
  return {
    sellerCount: records[0]?.sellerCount ?? 0,
    requests: records.length,
    served: served.length,
    failures,
    reselected: records.filter((record) => record.sellers.length > 1).length,
    bySeller,
    headersMs: spread(served.map((record) => record.headersMs ?? 0)),
    firstTokenMs: spread(served.map((record) => record.firstTokenMs!)),
    totalMs: spread(served.map((record) => record.totalMs)),
    sellerWaitMs: spread(served.flatMap((record) => record.waitsMs)),
    openingFirstTokenMs: served
      .filter((record) => record.turn === 0)
      .map((record) => round(record.firstTokenMs!)),
  };
}
