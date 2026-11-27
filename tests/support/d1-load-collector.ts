import {
  runAggregation,
  type AggregationResult,
} from '@gyblos/metrics-collector/aggregate';
import { AGGREGATES } from '@gyblos/metrics-collector/constants';

import { D1_LOAD_LABELS, measureD1Step, type D1LoadRow } from './d1-load-log';
import {
  DAY_START,
  HOUR,
  insertReceipt,
  NOW,
  SELLER_B,
} from './metrics-collector-aggregates';
import { createCollectorD1 } from './metrics-collector-d1';

const RECEIPTS_PER_DAY = 3;

export function completedAggregation(result: AggregationResult, days: number) {
  if (
    result.days.length !== days ||
    result.failed.length ||
    result.more ||
    result.scanFailed ||
    result.chain.failed.length ||
    result.chain.more ||
    result.chain.scanFailed
  )
    throw new Error('incomplete aggregation run');
}

function aggregation(label: D1LoadRow['label'], days: number) {
  const database = createCollectorD1();
  for (let day = 0; day < days; day++)
    for (let receipt = 0; receipt < RECEIPTS_PER_DAY; receipt++)
      insertReceipt(database, {
        seller: receipt % 2 ? SELLER_B : undefined,
        receivedAt: DAY_START - day * AGGREGATES.dayMs + (receipt + 1) * HOUR,
      });
  return measureD1Step(label, database, async () =>
    completedAggregation(await runAggregation(database, NOW), days),
  );
}

export async function collectorLoad(): Promise<D1LoadRow[]> {
  return [
    await aggregation(D1_LOAD_LABELS.AGG_DAY_1, 1),
    await aggregation(D1_LOAD_LABELS.AGG_DAYS_31, AGGREGATES.maxDaysPerRun),
  ];
}
