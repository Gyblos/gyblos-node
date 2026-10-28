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
export function metricReasoning(record: object) {
  const value = field(record, 'reasoningTokens');
  return value === null ? null : controlInteger(value);
}
