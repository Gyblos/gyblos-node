import { HTTP_STATUS } from '@gyblos/config';

import type { ReplayTiming } from './client';
import { AGENT_REPLAY } from './constants';
import type { SellerTrace } from './network';

export type ReplayRecord = Omit<ReplayTiming, 'text'> & {
  sellerCount: number;
  traced: boolean;
  admissionMs: number | null;
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
      traced: trace !== undefined,
      admissionMs: trace ? round(trace.admittedAtMs - timing.startMs) : null,
      sellers: trace?.sellers ?? [],
      waitsMs: (trace?.waitsMs ?? []).map(round),
    };
  });
}

const completed = (record: ReplayRecord) =>
  record.status === HTTP_STATUS.ok &&
  record.firstTokenMs !== null &&
  record.code === null;

export function summarize(records: ReplayRecord[]) {
  const served = records.filter(completed);
  const failed = records.filter((record) => !completed(record));
  const failures: Record<string, number> = {};
  for (const record of failed) {
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
    untraced: records.filter((record) => !record.traced).length,
    failedTotalMs: spread(failed.map((record) => record.totalMs)),
    reselected: records.filter((record) => record.sellers.length > 1).length,
    bySeller,
    headersMs: spread(served.map((record) => record.headersMs ?? 0)),
    firstTokenMs: spread(served.map((record) => record.firstTokenMs!)),
    totalMs: spread(served.map((record) => record.totalMs)),
    admissionMs: spread(
      served.flatMap((record) =>
        record.admissionMs === null ? [] : [record.admissionMs],
      ),
    ),
    sellerWaitMs: spread(served.flatMap((record) => record.waitsMs)),
    openingFirstTokenMs: served
      .filter((record) => record.turn === 0)
      .map((record) => round(record.firstTokenMs!)),
  };
}
