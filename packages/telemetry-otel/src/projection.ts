// Reads only the detached core projection into bounded metric fields; never re-reads the producer object.
import type { Attributes } from '@opentelemetry/api';

import {
  ENGINE_KINDS,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import {
  controlFail,
  controlInteger,
} from '@gyblos/protocol/control-validation';
import {
  EXECUTION_ROUTES,
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
} from '@gyblos/protocol/telemetry';

function field(record: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}
function member<T extends string>(
  value: unknown,
  catalog: Readonly<Record<string, T>>,
): T {
  for (const item of Object.values(catalog)) if (item === value) return item;
  return controlFail();
}
export function metricType(record: object) {
  return member(field(record, 'type'), TELEMETRY_EVENTS);
}
export function metricNumber(record: object, key: string) {
  return controlInteger(field(record, key));
}
export function metricObject(record: object, key: string): object {
  const value = field(record, key);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return controlFail();
  return value;
}
export function metricAttributes(record: object): Attributes {
  const streaming = field(record, 'streaming');
  if (typeof streaming !== 'boolean') return controlFail();
  const engine = field(record, 'engineKind');
  return {
    role: member(field(record, 'role'), P2P_ROLES),
    streaming,
    ...(engine === null ? {} : { engine: member(engine, ENGINE_KINDS) }),
  };
}
export function failureAttributes(
  record: object,
  common: Attributes,
): Attributes {
  const reason = field(record, 'reason');
  return {
    ...common,
    code: member(field(record, 'code'), FREE_EXECUTION_CODES),
    ...(reason === null
      ? {}
      : { reason: member(reason, FREE_EXECUTION_STOP_REASONS) }),
  };
}
export function refusalAttributes(
  record: object,
  common: Attributes,
): Attributes {
  return {
    ...common,
    refusal: member(field(record, 'refusal'), TELEMETRY_REFUSALS),
  };
}
const MILLISECONDS_PER_SECOND = 1000;
// Output tokens per second of engine generation; null when the engine reported no generation time.
export function metricOutputRate(record: object, usage: object) {
  if (!Object.hasOwn(record, 'generationMs')) return null;
  const generationMs = controlInteger(field(record, 'generationMs'));
  const outputTokens = metricNumber(usage, 'outputTokens');
  if (generationMs <= 0 || outputTokens <= 0) return null;
  return (outputTokens * MILLISECONDS_PER_SECOND) / generationMs;
}
// The route attributes of one execution, or null when its producer observed none.
export function metricRoute(record: object): Attributes | null {
  if (!Object.hasOwn(record, 'path')) return null;
  const path = metricObject(record, 'path');
  const changed = field(path, 'routeChanged');
  if (typeof changed !== 'boolean') return controlFail();
  return {
    route: member(field(path, 'route'), EXECUTION_ROUTES),
    route_changed: changed,
  };
}
export function metricReasoning(record: object) {
  const value = field(record, 'reasoningTokens');
  return value === null ? null : controlInteger(value);
}
