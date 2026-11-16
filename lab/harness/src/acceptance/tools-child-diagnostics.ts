// Bounded child output is untrusted: accept only known frames and never echo raw text.
import { randomUUID } from 'node:crypto';

import {
  DIAGNOSTIC_CAUSES,
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_OUTCOMES,
} from '@gyblos/runtime/constants';
import {
  diagnosticRecord,
  type DiagnosticRecord,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';

import { ACCEPTANCE_CODES } from './constants';
import { AcceptanceError } from './errors';
import { TOOL_DIAGNOSTICS, type ToolAcceptanceCase } from './tools-constants';
import { toolDiagnostic, toolDiagnostics } from './tools-diagnostics';

export class ToolAcceptanceFailure extends AcceptanceError {
  constructor(
    code: AcceptanceError['code'],
    readonly diagnostic?: DiagnosticRecord,
  ) {
    super(code);
  }
}
export function childFrames(text: string, scenario: ToolAcceptanceCase) {
  const lines = text.trim().split('\n');
  let final = '';
  let valid = true;
  const diagnostics: DiagnosticRecord[] = [];
  for (const [index, line] of lines.entries()) {
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      if (index !== lines.length - 1) valid = false;
      final = line;
      continue;
    }
    if (input && typeof input === 'object' && 'diagnostic' in input) {
      const frame = toolDiagnostic(input.diagnostic, scenario);
      if (frame) diagnostics.push(frame);
      else valid = false;
    } else if (index === lines.length - 1) final = line;
    else valid = false;
  }
  return { final, diagnostics, valid };
}
export function childFailure(options: {
  output: string;
  observation?: Pick<DiagnosticRecord, 'at' | 'durationMs'>;
  scenario: ToolAcceptanceCase;
  code: AcceptanceError['code'];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  cancelled: boolean;
  sink?: DiagnosticSink;
}) {
  if (!options.observation) return new ToolAcceptanceFailure(options.code);
  let records: DiagnosticRecord[] = [];
  try {
    records = childFrames(options.output, options.scenario).diagnostics;
  } catch {
    /* Malformed output remains a static failure. */
  }
  let diagnostic: DiagnosticRecord | undefined;
  try {
    let fallback: DiagnosticRecord | undefined;
    toolDiagnostics((record) => {
      fallback = record;
    })
      .start()
      .report({
        phase: TOOL_DIAGNOSTICS.phases.STARTUP,
        scenario: options.scenario,
        code: options.code,
      });
    const primary =
      records
        .filter((record) => record.outcome === DIAGNOSTIC_OUTCOMES.FAILURE)
        .at(-1) ??
      records.at(-1) ??
      fallback;
    if (!primary) return new ToolAcceptanceFailure(options.code);
    diagnostic = diagnosticRecord({
      ...primary,
      at: options.observation.at,
      durationMs: options.observation.durationMs,
      id: randomUUID(),
      code: options.code,
      level: DIAGNOSTIC_LEVELS.ERROR,
      cause: options.timedOut
        ? DIAGNOSTIC_CAUSES.TIMEOUT
        : options.cancelled
          ? DIAGNOSTIC_CAUSES.ABORT
          : primary.cause,
      exitCode: options.exitCode,
      signal: options.signal,
      stdoutBytes: options.stdoutBytes,
      stderrBytes: options.stderrBytes,
      outcome: options.cancelled
        ? DIAGNOSTIC_OUTCOMES.CANCELLED
        : options.timedOut
          ? DIAGNOSTIC_OUTCOMES.TIMEOUT
          : DIAGNOSTIC_OUTCOMES.FAILURE,
    })!;
  } catch {
    /* Metadata failure must not replace the canonical operation failure. */
  }
  const emit = (record: DiagnosticRecord) => {
    try {
      options.sink?.(record);
    } catch {
      /* Observational output is best effort. */
    }
  };
  for (const record of records.filter(
    (record) => record.outcome === DIAGNOSTIC_OUTCOMES.CLEANUP_FAILURE,
  ))
    emit(record);
  if (diagnostic) emit(diagnostic);
  return new ToolAcceptanceFailure(options.code, diagnostic);
}
