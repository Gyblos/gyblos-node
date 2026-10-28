// Provides an in-memory exporter and assertions over real SDK aggregates; no collector or network.
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type {
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

export function metricExporter() {
  const batches: ResourceMetrics[] = [];
  let shutdowns = 0;
  const exporter: PushMetricExporter = {
    export(metrics, callback: (result: ExportResult) => void) {
      batches.push(metrics);
      callback({ code: ExportResultCode.SUCCESS });
    },
    async forceFlush() {},
    async shutdown() {
      shutdowns++;
    },
  };
  return { exporter, batches, shutdowns: () => shutdowns };
}
export function points(batches: ResourceMetrics[], name: string) {
  return (
    batches
      .at(-1)
      ?.scopeMetrics.flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name === name)
      .flatMap(
        (metric): import('@opentelemetry/sdk-metrics').DataPoint<unknown>[] =>
          metric.dataPoints,
      ) ?? []
  );
}
