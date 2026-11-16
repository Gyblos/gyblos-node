// Validates untrusted JSONL/child output and copies only bounded, content-free metadata.
import {
  DIAGNOSTIC_CAUSES,
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_OUTCOMES,
} from './constants';
import type { DiagnosticRecord } from './diagnostics';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNAL = /^SIG[A-Z0-9]{1,12}$/;
function token(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= DIAGNOSTIC_FORMAT.tokenCharacters &&
    TOKEN.test(value)
  );
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function optionalInteger(value: unknown) {
  return value === undefined || integer(value);
}
export function diagnosticRecord(input: unknown): DiagnosticRecord | undefined {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const field = (name: string): unknown =>
      Object.getOwnPropertyDescriptor(input, name)?.value;
    const schema = field('schema');
    const id = field('id');
    const at = field('at');
    const version = field('version');
    const level = Object.values(DIAGNOSTIC_LEVELS).find(
      (item) => item === field('level'),
    );
    const component = field('component');
    const operation = field('operation');
    const phase = field('phase');
    const correlationId = field('correlationId');
    const code = field('code');
    const outcome = Object.values(DIAGNOSTIC_OUTCOMES).find(
      (item) => item === field('outcome'),
    );
    const cause = Object.values(DIAGNOSTIC_CAUSES).find(
      (item) => item === field('cause'),
    );
    const durationMs = field('durationMs');
    const scenario = field('scenario');
    const exitCode = field('exitCode');
    const signal = field('signal');
    const stdoutBytes = field('stdoutBytes');
    const stderrBytes = field('stderrBytes');
    if (
      schema !== DIAGNOSTIC_FORMAT.schema ||
      !uuid(id) ||
      typeof at !== 'string' ||
      new Date(at).toISOString() !== at ||
      !token(version) ||
      !level ||
      !token(component) ||
      !token(operation) ||
      !token(phase) ||
      !uuid(correlationId) ||
      !token(code) ||
      !outcome ||
      !cause ||
      !integer(durationMs) ||
      (scenario !== undefined && !token(scenario)) ||
      (exitCode !== undefined && exitCode !== null && !integer(exitCode)) ||
      (signal !== undefined &&
        signal !== null &&
        (typeof signal !== 'string' || !SIGNAL.test(signal))) ||
      !optionalInteger(stdoutBytes) ||
      !optionalInteger(stderrBytes)
    )
      return;
    return {
      schema,
      id,
      at,
      version,
      level,
      component,
      operation,
      phase,
      correlationId,
      code,
      outcome,
      cause,
      durationMs,
      ...(scenario === undefined ? {} : { scenario }),
      ...(exitCode === undefined ? {} : { exitCode }),
      // Validated OS signal metadata is not interpreted as a control instruction.
      ...(signal === undefined
        ? {}
        : { signal: signal as NodeJS.Signals | null }),
      ...(stdoutBytes === undefined ? {} : { stdoutBytes }),
      ...(stderrBytes === undefined ? {} : { stderrBytes }),
    };
  } catch {
    return undefined;
  }
}
