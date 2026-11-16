// Owner catalogs supply codes and phases; runtime owns only safe envelopes and lifecycle metadata.
import { AssertionError } from 'node:assert';
import { randomUUID } from 'node:crypto';

import {
  DIAGNOSTIC_CAUSES,
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_OUTCOMES,
  type DiagnosticCause,
  type DiagnosticLevel,
  type DiagnosticOutcome,
} from './constants';
import { diagnosticRecord } from './diagnostic-record';

export { diagnosticRecord } from './diagnostic-record';
export { createDiagnosticLog } from './diagnostic-log';
export {
  readDiagnostics,
  followDiagnostics,
  type DiagnosticFilter,
} from './diagnostic-reader';
export interface DiagnosticRecord {
  schema: typeof DIAGNOSTIC_FORMAT.schema;
  id: string;
  at: string;
  version: string;
  level: DiagnosticLevel;
  component: string;
  operation: string;
  phase: string;
  correlationId: string;
  code: string;
  outcome: DiagnosticOutcome;
  cause: DiagnosticCause;
  durationMs: number;
  scenario?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutBytes?: number;
  stderrBytes?: number;
}
export type DiagnosticSink = (record: DiagnosticRecord) => void;
export interface DiagnosticEvent<P, C> {
  phase: P;
  code: C;
  level?: DiagnosticLevel;
  outcome?: DiagnosticOutcome;
  cause?: DiagnosticCause;
  scenario?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutBytes?: number;
  stderrBytes?: number;
}
export function diagnosticCause(error: unknown): DiagnosticCause {
  try {
    if (error instanceof AssertionError) return DIAGNOSTIC_CAUSES.ASSERTION;
    if (error instanceof SyntaxError) return DIAGNOSTIC_CAUSES.SYNTAX;
    if (error instanceof Error && error.name === 'AbortError')
      return DIAGNOSTIC_CAUSES.ABORT;
    if (error instanceof Error && error.name === 'TimeoutError')
      return DIAGNOSTIC_CAUSES.TIMEOUT;
  } catch {
    /* Unknown errors never become messages or stacks. */
  }
  return DIAGNOSTIC_CAUSES.UNKNOWN;
}

export function createDiagnostics<
  const P extends string,
  const C extends string,
>(options: {
  component: string;
  operation: string;
  phases: readonly P[];
  codes: readonly C[];
  scenarios?: readonly string[];
  version?: string;
  level?: DiagnosticLevel;
  enabled?: boolean;
  sink?: DiagnosticSink;
}) {
  let dropped = 0;
  const levels = Object.values(DIAGNOSTIC_LEVELS);
  return {
    health: () => ({ dropped }),
    start() {
      const correlationId = randomUUID();
      const started = performance.now();
      return {
        correlationId,
        report(event: DiagnosticEvent<P, C>) {
          if (options.enabled === false || !options.sink) return;
          try {
            // Projection precedes serialization; descriptors avoid invoking getters or toJSON.
            const record = diagnosticRecord({
              ...Object.fromEntries(
                Object.entries(Object.getOwnPropertyDescriptors(event))
                  .filter(([, descriptor]) => 'value' in descriptor)
                  .map(([key, descriptor]) => [key, descriptor.value]),
              ),
              schema: DIAGNOSTIC_FORMAT.schema,
              id: randomUUID(),
              at: new Date().toISOString(),
              version: options.version ?? DIAGNOSTIC_FORMAT.sourceVersion,
              component: options.component,
              operation: options.operation,
              correlationId,
              durationMs: Math.floor(performance.now() - started),
              level:
                Object.getOwnPropertyDescriptor(event, 'level')?.value ??
                DIAGNOSTIC_LEVELS.ERROR,
              outcome:
                Object.getOwnPropertyDescriptor(event, 'outcome')?.value ??
                DIAGNOSTIC_OUTCOMES.FAILURE,
              cause:
                Object.getOwnPropertyDescriptor(event, 'cause')?.value ??
                DIAGNOSTIC_CAUSES.UNKNOWN,
            });
            if (
              !record ||
              !options.phases.some((value) => value === record.phase) ||
              !options.codes.some((value) => value === record.code) ||
              (record.scenario !== undefined &&
                !options.scenarios?.includes(record.scenario))
            ) {
              dropped++;
              return;
            }
            if (
              levels.indexOf(record.level) <
              levels.indexOf(options.level ?? DIAGNOSTIC_LEVELS.WARN)
            )
              return;
            options.sink(record);
          } catch {
            dropped++;
          }
        },
      };
    },
  };
}
