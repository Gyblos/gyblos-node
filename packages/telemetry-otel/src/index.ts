// Owns an opt-in, lazy aggregate metrics lifecycle; no node wiring, global provider or default destination.
import { emptyResource } from '@opentelemetry/resources';
import {
  AggregationType,
  InstrumentType,
  MeterProvider,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';

import { toTelemetryRecord } from '@gyblos/core/telemetry';
import {
  TELEMETRY_EVENTS,
  type TelemetryHealth,
  type TelemetrySink,
} from '@gyblos/protocol/telemetry';

import { OTEL_METRICS, OTEL_SETTINGS } from './constants';
import { createMeasurements } from './metrics';
import { metricType } from './projection';
import { ExplicitMetricReader } from './reader';

export interface OtelTelemetryOptions {
  exporter: PushMetricExporter;
}
function initialize(exporter: PushMetricExporter) {
  const provider = new MeterProvider({
    resource: emptyResource(),
    readers: [new ExplicitMetricReader(exporter)],
    views: [
      {
        instrumentName: 'gyblos.*',
        aggregationCardinalityLimit: OTEL_SETTINGS.cardinality,
        instrumentType: InstrumentType.COUNTER,
      },
      ...[
        [OTEL_METRICS.FIRST_TOKEN, OTEL_SETTINGS.latencyBoundaries],
        [OTEL_METRICS.DURATION, OTEL_SETTINGS.latencyBoundaries],
        [OTEL_METRICS.OUTPUT_RATE, OTEL_SETTINGS.rateBoundaries],
      ].map(([instrumentName, boundaries]) => ({
        instrumentName: instrumentName as string,
        instrumentType: InstrumentType.HISTOGRAM,
        aggregationCardinalityLimit: OTEL_SETTINGS.cardinality,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM as const,
          options: { boundaries: [...(boundaries as readonly number[])] },
        },
      })),
    ],
  });
  return {
    provider,
    record: createMeasurements(provider.getMeter(OTEL_SETTINGS.scope)),
  };
}
export function createOtelTelemetrySink({
  exporter,
}: OtelTelemetryOptions): TelemetrySink {
  let active: ReturnType<typeof initialize> | undefined;
  let emitted = 0;
  let dropped = 0;
  let failed = false;
  let exportFailed = false;
  let flushing: Promise<void> | undefined;
  let closing: Promise<TelemetryHealth> | undefined;
  const exportMetrics = async () => {
    if (exportFailed) return;
    try {
      await active?.provider.forceFlush();
    } catch {
      failed = true;
      exportFailed = true;
    }
  };
  return {
    emit(event) {
      if (closing) {
        dropped++;
        return;
      }
      try {
        const record = toTelemetryRecord(event);
        const type = metricType(record);
        if (
          type !== TELEMETRY_EVENTS.RECEIPT &&
          type !== TELEMETRY_EVENTS.CHARGED
        ) {
          active ??= initialize(exporter);
          active.record(record);
        }
        emitted++;
      } catch {
        dropped++;
        failed = true;
      }
    },
    async flush() {
      if (closing) {
        await closing;
        return;
      }
      if (!active) return;
      flushing ??= exportMetrics().finally(() => {
        flushing = undefined;
      });
      await flushing;
    },
    close() {
      closing ??= (async () => {
        await flushing;
        await exportMetrics();
        try {
          await active?.provider.shutdown();
        } catch {
          failed = true;
        }
        return { emitted, dropped, failed };
      })();
      return closing;
    },
  };
}
