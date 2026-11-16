// Lazy bounded persistence; diagnostics remain observational even when storage is unavailable.
import { PRIVATE_LOG_LIMITS } from '@gyblos/config';

import { diagnosticRecord } from './diagnostic-record';
import type { DiagnosticSink } from './diagnostics';
import { createPrivateLog } from './private-log';

async function bounded(work: Promise<unknown>, expire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(expire),
      new Promise<void>((done) => {
        timer = setTimeout(() => {
          expire();
          done();
        }, PRIVATE_LOG_LIMITS.drainMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class DiagnosticLog {
  private readonly pending: object[] = [];
  private log: Awaited<ReturnType<typeof createPrivateLog>> | undefined;
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private dropped = 0;
  private failed = false;
  private abandoned = false;
  private closed = false;
  constructor(private readonly directory: string) {}
  private readonly expire = () => {
    this.failed = true;
    this.abandoned = true;
    this.dropped += this.pending.length;
    this.pending.splice(0);
    // A late open is closed by the opening task; an existing file has its own bounded close.
    void this.log?.close().catch(() => {
      this.failed = true;
    });
  };
  private async open() {
    try {
      this.log = await createPrivateLog(this.directory);
      if (this.abandoned) {
        await this.log.close();
        return;
      }
      for (const item of this.pending.splice(0)) this.log.write(item);
    } catch {
      this.expire();
    }
  }
  readonly write: DiagnosticSink = (input) => {
    if (this.closing || this.failed) {
      this.dropped++;
      return;
    }
    const record = diagnosticRecord(input);
    if (!record) {
      this.dropped++;
      return;
    }
    if (this.log) {
      this.log.write(record);
      return;
    }
    if (this.pending.length >= PRIVATE_LOG_LIMITS.pendingRecords) {
      this.dropped++;
      return;
    }
    this.pending.push(record);
    this.opening ??= this.open();
  };
  private async drain(close: boolean) {
    await this.opening;
    if (close) await this.log?.close();
    else await this.log?.flush();
  }
  readonly health = () => ({
    failed: this.failed || this.log?.health().code !== undefined,
    dropped: this.dropped + (this.log?.health().dropped ?? 0),
    closed: this.closed,
  });
  readonly flush = () => bounded(this.drain(false), this.expire);
  readonly close = () => {
    this.closing ??= bounded(this.drain(true), this.expire).finally(() => {
      this.closed = true;
    });
    return this.closing;
  };
}
export function createDiagnosticLog(directory: string) {
  return new DiagnosticLog(directory);
}
