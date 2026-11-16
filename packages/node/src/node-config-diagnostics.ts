// Diagnostic controls are independent of the telemetry file flag.
import {
  DIAGNOSTIC_LEVELS,
  type DiagnosticLevel,
} from '@gyblos/runtime/constants';

import {
  flag,
  oneOf,
  optional,
  table,
  unknownKeys,
  withoutUndefined,
  type ConfigPath,
  type IssueList,
} from './node-config-fields';

export interface DiagnosticSettings {
  enabled?: boolean;
  level?: DiagnosticLevel;
}
export function readDiagnosticSettings(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
) {
  const settings = table(value, path, issues);
  if (!settings) return undefined;
  const enabled = optional(settings, 'enabled', path, (item, at) =>
    flag(item, at, issues),
  );
  const level = optional(settings, 'level', path, (item, at) =>
    oneOf(item, Object.values(DIAGNOSTIC_LEVELS), at, issues),
  );
  unknownKeys(settings, path, ['enabled', 'level'], issues);
  return withoutUndefined({ enabled, level });
}
