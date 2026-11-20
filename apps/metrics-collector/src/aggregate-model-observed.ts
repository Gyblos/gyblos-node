// Owns the per-model observations rollup (migrations/0007): telemetry events joined to their headline
// receipt, one sample of each kind per receipt, then histograms per model and paid flag on the
// receipt's day. Formulas live in aggregate-sql.ts.
import { and, eq, sql } from 'drizzle-orm';

import {
  blank,
  modelObservedEvents,
  observationJoin,
  perReceiptObserved,
  receiptOfObservation,
  versionFields,
} from './aggregate-sql';
import { AGGREGATES } from './constants';
import type { CollectorDatabase } from './d1-client';
import type { DayBounds } from './days';
import {
  aggModelObservedDaily,
  envelopes,
  observations,
  receipts,
} from './schema';
import { histogram, inRange, ordered } from './sql-primitives';

// Per model and paid flag, on the day of the receipt each event belongs to: first one sample of each
// kind per receipt, then the histograms over those samples.
export function modelObservedRollup(
  database: CollectorDatabase,
  bounds: DayBounds,
  now: number,
) {
  const sample = database
    .select({
      modelId: receipts.modelId,
      variant: blank(receipts.variant).as('variant'),
      quantization: blank(receipts.quantization).as('quantization'),
      paid: receipts.paid,
      ...perReceiptObserved(),
    })
    .from(receipts)
    .innerJoin(observations, receiptOfObservation)
    .innerJoin(envelopes, observationJoin)
    .where(and(inRange(receipts.sellerReceivedAt, bounds), modelObservedEvents))
    .groupBy(receipts.receiptKey)
    .as('sample');
  const model = [
    sample.modelId,
    sql`${sample.variant}`,
    sql`${sample.quantization}`,
    sample.paid,
  ];
  return [
    database
      .delete(aggModelObservedDaily)
      .where(eq(aggModelObservedDaily.day, bounds.day)),
    database.insert(aggModelObservedDaily).select(
      database
        .select(
          ordered(aggModelObservedDaily, {
            day: sql<string>`${bounds.day}`,
            modelId: sample.modelId,
            variant: sample.variant,
            quantization: sample.quantization,
            paid: sample.paid,
            buyerFirstTokenHist: histogram(sql`${sample.firstTokenMs}`),
            engineTpsHist: histogram(
              sql`${sample.tokensPerSecond}`,
              AGGREGATES.tokensPerSecondBuckets,
            ),
            ...versionFields(now),
          }),
        )
        .from(sample)
        .groupBy(...model),
    ),
  ];
}
