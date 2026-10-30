// Composes opt-in local file telemetry; startup closes only its own sink after the role stops.
// Failures are static health metadata and never affect inference, admission or retry policy.
import { resolve } from 'node:path';

import {
  NODE_ENVIRONMENT,
  type HomeEnvironment,
  type HomeRole,
} from '@gyblos/config';
import { fanOut } from '@gyblos/core/telemetry';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import { createFileTelemetrySink } from '@gyblos/telemetry-file';

import {
  LOCAL_TELEMETRY,
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_ISSUE_CODES,
  NODE_ERROR_CODES,
} from './constants';
import { NodeError } from './errors';
import { readNodeConfigFile } from './node-config';

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
  const explicit = environment[NODE_ENVIRONMENT.config];
  const parsed = await readNodeConfigFile(
    resolve(cwd, explicit || NODE_CONFIG_FILENAME),
  );
  if (parsed.ok) return parsed.config.telemetry?.file ?? false;
  if (
    !explicit &&
    parsed.issues.length === 1 &&
    parsed.issues[0]!.code === NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND
  )
    return false;
  throw new NodeError(NODE_ERROR_CODES.NODE_CONFIG_INVALID);
}
