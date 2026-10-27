// Projects content-free events and isolates sink failures; no clock, filesystem or plugin dependencies.
import {
  CONTROL_LIMITS,
  ENGINE_DONE_REASONS,
  ENGINE_KINDS,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import { parseModelSelection } from '@gyblos/protocol/control-requests';
import {
  controlAddress,
  controlAtomic,
  controlFail,
  controlHex,
  controlInteger,
  controlNetwork,
} from '@gyblos/protocol/control-validation';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
  type TelemetryEvent,
  type TelemetryHealth,
  type TelemetrySink,
} from '@gyblos/protocol/telemetry';

import {
  telemetryField,
  telemetryFields,
  telemetryReceipt,
} from './telemetry-projection';

function member<T extends string>(
  value: unknown,
  catalog: Readonly<Record<string, T>>,
): T {
  for (const item of Object.values(catalog)) if (item === value) return item;
  return controlFail();
}
function bool(value: unknown) {
  if (typeof value !== 'boolean') return controlFail();
  return value;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T) {
  return value === null ? null : parse(value);
}
function numbers(
  value: unknown,
  fields: readonly string[],
  nullableFields: readonly string[] = [],
) {
  const result: Record<string, number | null> = {};
  for (const key of fields) {
    const field = telemetryField(value, key);
    result[key] = nullableFields.includes(key)
      ? nullable(field, controlInteger)
      : controlInteger(field);
  }
  return result;
}
export function toTelemetryRecord(event: TelemetryEvent): object {
  const type = member(telemetryField(event, 'type'), TELEMETRY_EVENTS);
  const sellerNodeId = nullable(
    telemetryField(event, 'sellerNodeId'),
    controlHex,
  );
  const engineKind = nullable(telemetryField(event, 'engineKind'), (value) =>
    member(value, ENGINE_KINDS),
  );
  const requestId = nullable(telemetryField(event, 'requestId'), (value) =>
    controlHex(value, CONTROL_LIMITS.requestIdBytes),
  );
  if (
    type === TELEMETRY_EVENTS.UNSERVED
      ? sellerNodeId !== null || engineKind !== null || requestId !== null
      : requestId === null ||
        (type !== TELEMETRY_EVENTS.REFUSED &&
          (sellerNodeId === null || engineKind === null))
  )
    return controlFail();
  const common = {
    type,
    at: controlInteger(telemetryField(event, 'at')),
    role: member(telemetryField(event, 'role'), P2P_ROLES),
    requestId,
    buyerNodeId: controlHex(telemetryField(event, 'buyerNodeId')),
    sellerNodeId,
    engineKind,
    selection: parseModelSelection(
      telemetryFields(telemetryField(event, 'selection'), [
        'modelId',
        'variant',
        'quantization',
      ]),
    ),
    streaming: bool(telemetryField(event, 'streaming')),
  };
  return { ...common, ...eventFields(event, type) };
}
function eventFields(
  event: TelemetryEvent,
  type: TelemetryEvent['type'],
): object {
  switch (type) {
    case TELEMETRY_EVENTS.FIRST_TOKEN:
      return {
        firstTokenMs: controlInteger(telemetryField(event, 'firstTokenMs')),
      };
    case TELEMETRY_EVENTS.COMPLETED:
      return {
        usage: numbers(
          telemetryField(event, 'usage'),
          ['inputTokens', 'outputTokens', 'reasoningTokens'],
          ['reasoningTokens'],
        ),
        sizes: numbers(telemetryField(event, 'sizes'), [
          'inputBytes',
          'outputBytes',
          'inputChars',
          'outputChars',
        ]),
        totalMs: controlInteger(telemetryField(event, 'totalMs')),
        finishReason: member(
          telemetryField(event, 'finishReason'),
          ENGINE_DONE_REASONS,
        ),
      };
    case TELEMETRY_EVENTS.FAILED:
      return {
        code: member(telemetryField(event, 'code'), FREE_EXECUTION_CODES),
        reason: nullable(telemetryField(event, 'reason'), (value) =>
          member(value, FREE_EXECUTION_STOP_REASONS),
        ),
        totalMs: controlInteger(telemetryField(event, 'totalMs')),
        ...(Object.hasOwn(event, 'delivered')
          ? {
              delivered: numbers(telemetryField(event, 'delivered'), [
                'outputTokens',
              ]),
            }
          : {}),
      };
    case TELEMETRY_EVENTS.CHARGED:
      return {
        amountAtomic: controlAtomic(telemetryField(event, 'amountAtomic')),
        feeAtomic: controlAtomic(telemetryField(event, 'feeAtomic')),
        network: controlNetwork(telemetryField(event, 'network')),
        asset: controlAddress(telemetryField(event, 'asset')),
      };
    case TELEMETRY_EVENTS.REFUSED:
      return {
        refusal: member(telemetryField(event, 'refusal'), TELEMETRY_REFUSALS),
      };
    case TELEMETRY_EVENTS.RECEIPT:
      return { receipt: telemetryReceipt(telemetryField(event, 'receipt')) };
    default:
      return {};
  }
}
export function fanOut(sinks: readonly TelemetrySink[]): TelemetrySink {
  const targets = [...sinks];
  let dropped = 0;
  let failed = false;
  let closing: Promise<TelemetryHealth> | undefined;
  return {
    emit(event) {
      if (closing) {
        dropped++;
        return;
      }
      for (const sink of targets) {
        try {
          sink.emit(event);
        } catch {
          dropped++;
          failed = true;
        }
      }
    },
    async flush() {
      await Promise.all(
        targets.map(async (sink) => {
          try {
            await sink.flush();
          } catch {
            failed = true;
          }
        }),
      );
    },
    close() {
      closing ??= (async () => {
        const health = await Promise.all(
          targets.map(async (sink) => {
            try {
              return await sink.close();
            } catch {
              failed = true;
              return { emitted: 0, dropped: 0, failed: true };
            }
          }),
        );
        return {
          emitted: health.reduce((count, item) => count + item.emitted, 0),
          dropped:
            dropped + health.reduce((count, item) => count + item.dropped, 0),
          failed: failed || health.some((item) => item.failed),
        };
      })();
      return closing;
    },
  };
}
