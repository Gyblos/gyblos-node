// Pushes only explicitly collected aggregates through an injected exporter; never schedules periodic I/O.
import { ExportResultCode } from '@opentelemetry/core';
import {
  MetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';

import { OTEL_ERROR_CODES, OTEL_SETTINGS } from './constants';

class OtelExportError extends Error {
  constructor(
    readonly code: (typeof OTEL_ERROR_CODES)[keyof typeof OTEL_ERROR_CODES],
  ) {
    super(code);
  }
}
export async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new OtelExportError(OTEL_ERROR_CODES.TIMEOUT)),
          OTEL_SETTINGS.operationTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export class ExplicitMetricReader extends MetricReader {
  constructor(private readonly exporter: PushMetricExporter) {
    super({ cardinalitySelector: () => OTEL_SETTINGS.cardinality });
  }
  protected async onForceFlush(): Promise<void> {
    const result = await bounded(() => this.collect());
    if (result.errors.length)
      throw new OtelExportError(OTEL_ERROR_CODES.EXPORT);
    await bounded(
      () =>
        new Promise<void>((resolve, reject) => {
          this.exporter.export(result.resourceMetrics, (result) => {
            if (result.code === ExportResultCode.SUCCESS) resolve();
            else reject(new OtelExportError(OTEL_ERROR_CODES.EXPORT));
          });
        }),
    );
    await bounded(() => this.exporter.forceFlush());
  }
  protected async onShutdown(): Promise<void> {
    await bounded(() => this.exporter.shutdown());
  }
}
