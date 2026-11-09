// Maps validated telemetry into a fixed aggregate schema; no identities, model strings or receipts escape.
import {
  ROOT_CONTEXT,
  type Attributes,
  type Counter,
  type Meter,
} from '@opentelemetry/api';

import { TELEMETRY_EVENTS } from '@gyblos/protocol/telemetry';

import { OTEL_METRICS, type OtelMetricName } from './constants';
import {
  failureAttributes,
  metricAttributes,
  metricNumber,
  metricObject,
  metricOutputRate,
  metricReasoning,
  metricRoute,
  metricType,
  refusalAttributes,
} from './projection';

function recordRoute(routes: Counter, record: object, attributes: Attributes) {
  const path = metricRoute(record);
  if (path) routes.add(1, { ...attributes, ...path }, ROOT_CONTEXT);
}
export function createMeasurements(meter: Meter) {
  const counter = (name: OtelMetricName, unit: string) =>
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
  const outputRate = meter.createHistogram(OTEL_METRICS.OUTPUT_RATE, {
    unit: '{token}/s',
  });
  const routes = counter(OTEL_METRICS.ROUTES, '{request}');
  const route = (record: object, attributes: Attributes) =>
    recordRoute(routes, record, attributes);
  return (record: object) => {
    const attributes = metricAttributes(record);
    switch (metricType(record)) {
      case TELEMETRY_EVENTS.REQUEST_RECEIVED:
        requests.add(1, attributes, ROOT_CONTEXT);
        break;
      case TELEMETRY_EVENTS.FIRST_TOKEN:
        firstToken.record(
          metricNumber(record, 'firstTokenMs'),
          attributes,
          ROOT_CONTEXT,
        );
        break;
      case TELEMETRY_EVENTS.COMPLETED: {
        const usage = metricObject(record, 'usage');
        const reasoningTokens = metricReasoning(usage);
        completed.add(1, attributes, ROOT_CONTEXT);
        input.add(metricNumber(usage, 'inputTokens'), attributes, ROOT_CONTEXT);
        output.add(
          metricNumber(usage, 'outputTokens'),
          attributes,
          ROOT_CONTEXT,
        );
        if (reasoningTokens !== null)
          reasoning.add(reasoningTokens, attributes, ROOT_CONTEXT);
        duration.record(
          metricNumber(record, 'totalMs'),
          attributes,
          ROOT_CONTEXT,
        );
        const rate = metricOutputRate(record, usage);
        if (rate !== null) outputRate.record(rate, attributes, ROOT_CONTEXT);
        route(record, { ...attributes, outcome: 'completed' });
        break;
      }
      case TELEMETRY_EVENTS.FAILED: {
        const failure = failureAttributes(record, attributes);
        failed.add(1, failure, ROOT_CONTEXT);
        duration.record(metricNumber(record, 'totalMs'), failure, ROOT_CONTEXT);
        if (Object.hasOwn(record, 'delivered'))
          delivered.add(
            metricNumber(metricObject(record, 'delivered'), 'outputTokens'),
            failure,
            ROOT_CONTEXT,
          );
        route(record, { ...attributes, outcome: 'failed' });
        break;
      }
      case TELEMETRY_EVENTS.REFUSED:
        refused.add(1, refusalAttributes(record, attributes), ROOT_CONTEXT);
        break;
      case TELEMETRY_EVENTS.UNSERVED:
        unserved.add(1, attributes, ROOT_CONTEXT);
        break;
    }
  };
}
