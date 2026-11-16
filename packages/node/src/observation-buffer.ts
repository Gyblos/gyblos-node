// Holds this node's content-free telemetry events in memory until the metrics uploader sends them.
// Bounded: when full, new events are counted as dropped rather than evicting older ones. Events are
// kept as core's validated projection, never raw objects. Receipts are not observations.
import { toTelemetryRecord } from '@gyblos/core/telemetry';
import {
  TELEMETRY_EVENTS,
  type TelemetryHealth,
  type TelemetrySink,
} from '@gyblos/protocol/telemetry';

import { OBSERVATION_BUFFER } from './constants';

export interface ObservationBuffer {
  sink: TelemetrySink;
  // Removes and returns up to `limit` of the oldest events.
  take(limit: number): Record<string, unknown>[];
  // Puts events back at the front after a failed upload.
  restore(events: readonly Record<string, unknown>[]): void;
  size(): number;
  dropped(): number;
}

export function createObservationBuffer(
  capacity: number = OBSERVATION_BUFFER.capacity,
): ObservationBuffer {
  let events: Record<string, unknown>[] = [];
  let dropped = 0;
  const health = (): TelemetryHealth => ({
    emitted: events.length,
    dropped,
    failed: false,
  });
  return {
    sink: {
      emit(event) {
        if (event.type === TELEMETRY_EVENTS.RECEIPT) return;
        if (events.length >= capacity) {
          dropped++;
          return;
        }
        try {
          // The projection validates and detaches; its output is a plain JSON record.
          events.push({ ...toTelemetryRecord(event) });
        } catch {
          dropped++;
        }
      },
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(health()),
    },
    take(limit) {
      const taken = events.slice(0, limit);
      events = events.slice(taken.length);
      return taken;
    },
    restore(restored) {
      const room = Math.max(0, capacity - events.length);
      events = [...restored.slice(0, room), ...events];
      dropped += Math.max(0, restored.length - room);
    },
    size: () => events.length,
    dropped: () => dropped,
  };
}
