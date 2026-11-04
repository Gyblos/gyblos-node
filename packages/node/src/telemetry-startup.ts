// Composes opt-in local file telemetry; startup closes only its own sink after the role stops.
// Failures are static health metadata and never affect inference, admission or retry policy.
import type { HomeEnvironment, HomeRole } from '@gyblos/config';
import { fanOut } from '@gyblos/core/telemetry';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import { createFileTelemetrySink } from '@gyblos/telemetry-file';

import { LOCAL_TELEMETRY, NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { readStartupConfig } from './node-config-file';

export interface LocalTelemetryOptions {
  enabled: boolean;
  environment: HomeEnvironment;
  role: HomeRole;
  sink?: TelemetrySink;
  createSink?: (options: {
    environment: HomeEnvironment;
    role: HomeRole;
  }) => TelemetrySink;
}
export function createLocalTelemetry(options: LocalTelemetryOptions) {
  const owned = options.sink === undefined && options.enabled;
  let failed = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let target = options.sink;
  if (owned) {
    try {
      target = fanOut([
        (options.createSink ?? createFileTelemetrySink)({
          environment: options.environment,
          role: options.role,
        }),
      ]);
    } catch {
      failed = true;
    }
  }
  const health = () => ({
    enabled: options.enabled || options.sink !== undefined,
    owned,
    closed,
    failed,
  });
  const close = () => {
    closing ??= (async () => {
      closed = true;
      if (!owned || !target) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve()
            .then(() => target!.close())
            .then((result) => {
              failed ||= result.failed;
            }),
          new Promise<void>((done) => {
            timer = setTimeout(() => {
              failed = true;
              done();
            }, LOCAL_TELEMETRY.closeMs);
          }),
        ]);
      } catch {
        failed = true;
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  };
  return { sink: target, health, close };
}

// Buyer startup consumes only this file-only setting; role/selection files still own its other settings.
export async function loadLocalTelemetry(
  environment: HomeEnvironment,
  cwd = process.cwd(),
) {
  const result = await readStartupConfig(environment, cwd);
  if (result.ok) return result.config?.telemetry?.file ?? false;
  throw new NodeError(NODE_ERROR_CODES.NODE_CONFIG_INVALID);
}
