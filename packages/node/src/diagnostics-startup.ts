// Owned local operational logging. No exporter, upload or relationship to receipt/telemetry policy.
import { NODE_ENVIRONMENT } from '@gyblos/config';
import {
  ROLE_FILES,
  rolePathIn,
  type HomeEnvironment,
  type HomeRole,
} from '@gyblos/config/home';
import { DIAGNOSTIC_LEVELS } from '@gyblos/runtime/constants';
import {
  createDiagnosticLog,
  diagnosticRecord,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import type { DiagnosticSettings } from './node-config-diagnostics';
import { readStartupConfig } from './node-config-file';

export async function loadLocalDiagnostics(
  environment: HomeEnvironment,
  cwd = process.cwd(),
) {
  const result = await readStartupConfig(environment, cwd);
  if (!result.ok) throw new NodeError(NODE_ERROR_CODES.NODE_CONFIG_INVALID);
  return result.config?.diagnostics ?? {};
}
export function createLocalDiagnostics(
  environment: HomeEnvironment,
  role: HomeRole,
  settings: DiagnosticSettings = {},
) {
  const log = createDiagnosticLog(
    rolePathIn(environment, role, ROLE_FILES.diagnostics),
  );
  const levels = Object.values(DIAGNOSTIC_LEVELS);
  const write: DiagnosticSink = (input) => {
    const record = diagnosticRecord(input);
    if (!record) return;
    if (
      settings.enabled === false ||
      levels.indexOf(record.level) <
        levels.indexOf(settings.level ?? DIAGNOSTIC_LEVELS.WARN)
    )
      return;
    const projected = diagnosticRecord({
      ...record,
      version: environment[NODE_ENVIRONMENT.version] ?? record.version,
    });
    log.write(projected ?? record);
  };
  return {
    write,
    close: log.close,
    health: () => ({ ...log.health(), enabled: settings.enabled !== false }),
  };
}
