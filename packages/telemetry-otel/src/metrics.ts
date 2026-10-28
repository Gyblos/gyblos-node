// Maps validated telemetry into a fixed aggregate schema; no identities, model strings or receipts escape.
import { ROOT_CONTEXT, type Attributes, type Meter } from '@opentelemetry/api';

import {
  TELEMETRY_EVENTS,
  type TelemetryEvent,
} from '@gyblos/protocol/telemetry';

import { OTEL_METRICS } from './constants';

export function createMeasurements(meter: Meter) {
  const counter = (name: string, unit: string) =>
    meter.createCounter(name, { unit });
  const requests = counter(OTEL_METRICS.REQUESTS, '{request}');
  const completed = counter(OTEL_METRICS.COMPLETED, '{request}');
  const failed = counter(OTEL_METRICS.FAILED, '{request}');
  const refused = counter(OTEL_METRICS.REFUSED, '{request}');
  const unserved = counter(OTEL_METRICS.UNSERVED, '{request}');
  const input = counter(OTEL_METRICS.INPUT_TOKENS, '{token}');
  const output = counter(OTEL_METRICS.OUTPUT_TOKENS, '{token}');
  const reasoning = counter(OTEL_METRICS.REASONING_TOKENS, '{token}');
  const delivered = counter(OTEL_METRICS.DELIVERED_OUTPUT_TOKENS, '{token}');
  const firstToken = meter.createHistogram(OTEL_METRICS.FIRST_TOKEN, {
    unit: 'ms',
  });
  const duration = meter.createHistogram(OTEL_METRICS.DURATION, { unit: 'ms' });
  return (event: TelemetryEvent) => {
    const attributes: Attributes = {
      role: event.role,
      streaming: event.streaming,
      ...(event.engineKind === null ? {} : { engine: event.engineKind }),
    };
    switch (event.type) {
      case TELEMETRY_EVENTS.REQUEST_RECEIVED:
        requests.add(1, attributes, ROOT_CONTEXT);
        break;
      case TELEMETRY_EVENTS.FIRST_TOKEN:
        firstToken.record(event.firstTokenMs, attributes, ROOT_CONTEXT);
        break;
      case TELEMETRY_EVENTS.COMPLETED:
        completed.add(1, attributes, ROOT_CONTEXT);
        input.add(event.usage.inputTokens, attributes, ROOT_CONTEXT);
        output.add(event.usage.outputTokens, attributes, ROOT_CONTEXT);
        if (event.usage.reasoningTokens !== null)
          reasoning.add(event.usage.reasoningTokens, attributes, ROOT_CONTEXT);
        duration.record(event.totalMs, attributes, ROOT_CONTEXT);
        break;
      case TELEMETRY_EVENTS.FAILED: {
        const failure = {
          ...attributes,
          code: event.code,
          ...(event.reason === null ? {} : { reason: event.reason }),
        };
        failed.add(1, failure, ROOT_CONTEXT);
        duration.record(event.totalMs, failure, ROOT_CONTEXT);
        if (event.delivered)
          delivered.add(event.delivered.outputTokens, failure, ROOT_CONTEXT);
        break;
      }
      case TELEMETRY_EVENTS.REFUSED:
        refused.add(1, { ...attributes, refusal: event.refusal }, ROOT_CONTEXT);
        break;
      case TELEMETRY_EVENTS.UNSERVED:
        unserved.add(1, attributes, ROOT_CONTEXT);
        break;
    }
  };
}
