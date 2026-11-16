// Lazy bounded persistence; diagnostics remain observational even when storage is unavailable.
import { PRIVATE_LOG_LIMITS } from '@gyblos/config';

import { diagnosticRecord } from './diagnostic-record';
import type { DiagnosticSink } from './diagnostics';
import { createPrivateLog } from './private-log';

export function createDiagnosticLog(directory: string) {
  const pending: object[] = [];
  let log: Awaited<ReturnType<typeof createPrivateLog>> | undefined;
  let opening: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let dropped = 0;
  let failed = false;
  const write: DiagnosticSink = (input) => {
    if (closing || failed) {
      dropped++;
      return;
    }
    const record = diagnosticRecord(input);
    if (!record) {
      dropped++;
      return;
    }
    if (log) {
      log.write(record);
      return;
    }
    if (pending.length >= PRIVATE_LOG_LIMITS.pendingRecords) {
      dropped++;
      return;
    }
    pending.push(record);
    opening ??= (async () => {
      try {
        log = await createPrivateLog(directory);
        for (const item of pending.splice(0)) log.write(item);
      } catch {
        failed = true;
        dropped += pending.length;
        pending.splice(0);
      }
    })();
  };
  return {
    write,
    health: () => ({
      failed: failed || log?.health().code !== undefined,
      dropped: dropped + (log?.health().dropped ?? 0),
      closed: closing !== undefined,
    }),
    async flush() {
      await opening;
      await log?.flush();
    },
    close() {
      closing ??= (async () => {
        await opening;
        await log?.close();
      })();
      return closing;
    },
  };
}
