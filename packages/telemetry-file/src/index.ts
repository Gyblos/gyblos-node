// Lazily persists bounded telemetry in a private role directory; never writes before the first emit.
import { PRIVATE_LOG_LIMITS } from '@gyblos/config';
import {
  ROLE_FILES,
  rolePathIn,
  type HomeEnvironment,
  type HomeRole,
} from '@gyblos/config/home';
import { toTelemetryRecord } from '@gyblos/core/telemetry';
import type {
  TelemetryHealth,
  TelemetrySink,
} from '@gyblos/protocol/telemetry';
import { createPrivateLog } from '@gyblos/runtime/private-log';

export function createFileTelemetrySink(options: {
  environment: HomeEnvironment;
  role: HomeRole;
}): TelemetrySink {
  const environment = { ...options.environment };
  const role = options.role;
  const pending: object[] = [];
  let opening: Promise<void> | undefined;
  let log: Awaited<ReturnType<typeof createPrivateLog>> | undefined;
  let emitted = 0;
  let dropped = 0;
  let failed = false;
  let closing: Promise<TelemetryHealth> | undefined;
  const open = () => {
    opening ??= (async () => {
      try {
        log = await createPrivateLog(
          rolePathIn(environment, role, ROLE_FILES.telemetry),
        );
        for (const record of pending.splice(0)) log.write(record);
      } catch {
        dropped += pending.length;
        pending.splice(0);
        failed = true;
      }
    })();
  };
  return {
    emit(event) {
      if (closing || failed) {
        dropped++;
        return;
      }
      try {
        const record = toTelemetryRecord(event);
        if (
          Buffer.byteLength(JSON.stringify(record) + '\n') >
          PRIVATE_LOG_LIMITS.recordBytes
        ) {
          dropped++;
          return;
        }
        if (log) {
          emitted++;
          log.write(record);
          return;
        }
        if (pending.length >= PRIVATE_LOG_LIMITS.pendingRecords) {
          dropped++;
          return;
        }
        pending.push(record);
        emitted++;
        open();
      } catch {
        dropped++;
      }
    },
    async flush() {
      await opening;
      await log?.flush();
    },
    close() {
      closing ??= (async () => {
        await opening;
        const health = await log?.close();
        return {
          emitted,
          dropped: dropped + (health?.dropped ?? 0),
          failed: failed || health?.code !== undefined,
        };
      })();
      return closing.then((health) => ({ ...health }));
    },
  };
}
