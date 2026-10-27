// Formats safe telemetry through injected output only; no global console or lifecycle on import.
import { toTelemetryRecord } from '@gyblos/core/telemetry';
import type {
  TelemetryHealth,
  TelemetrySink,
} from '@gyblos/protocol/telemetry';

export function createConsoleTelemetrySink({
  write,
}: {
  write: (line: string) => void;
}): TelemetrySink {
  let emitted = 0;
  let dropped = 0;
  let failed = false;
  let closed: TelemetryHealth | undefined;
  return {
    emit(event) {
      if (closed) {
        dropped++;
        return;
      }
      try {
        write(JSON.stringify(toTelemetryRecord(event)) + '\n');
        emitted++;
      } catch {
        dropped++;
        failed = true;
      }
    },
    async flush() {},
    async close() {
      closed ??= { emitted, dropped, failed };
      return { ...closed };
    },
  };
}
