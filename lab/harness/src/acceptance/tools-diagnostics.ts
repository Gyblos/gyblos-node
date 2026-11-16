// Safe phase frames cross the child boundary; exceptions, stderr text and request data never do.
import {
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_OUTCOMES,
} from '@gyblos/runtime/constants';
import {
  createDiagnostics,
  diagnosticCause,
  diagnosticRecord,
  type DiagnosticRecord,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';

import { ACCEPTANCE_CODES } from './constants';
import { AcceptanceError } from './errors';
import {
  TOOL_ACCEPTANCE_CASES,
  TOOL_DIAGNOSTICS,
  type ToolAcceptanceCase,
  type ToolDiagnosticPhase,
} from './tools-constants';
import { toolScenario } from './tools-scenario';

export function toolDiagnostic(
  input: unknown,
  scenario: ToolAcceptanceCase,
): DiagnosticRecord | undefined {
  const record = diagnosticRecord(input);
  if (
    !record ||
    record.component !== TOOL_DIAGNOSTICS.component ||
    record.operation !== TOOL_DIAGNOSTICS.operation ||
    record.scenario !== scenario ||
    !Object.values(TOOL_DIAGNOSTICS.phases).some(
      (value) => value === record.phase,
    ) ||
    ![
      ...Object.values(ACCEPTANCE_CODES),
      ...Object.values(TOOL_DIAGNOSTICS.codes),
    ].some((value) => value === record.code)
  )
    return;
  return record;
}
export function toolDiagnostics(sink?: DiagnosticSink) {
  return createDiagnostics({
    ...TOOL_DIAGNOSTICS,
    phases: Object.values(TOOL_DIAGNOSTICS.phases),
    codes: [
      ...Object.values(ACCEPTANCE_CODES),
      ...Object.values(TOOL_DIAGNOSTICS.codes),
    ],
    scenarios: Object.values(TOOL_ACCEPTANCE_CASES),
    level: DIAGNOSTIC_LEVELS.DEBUG,
    sink,
  });
}
export async function runToolCase(
  scenario: ToolAcceptanceCase,
  signal: AbortSignal,
  options: {
    sink?: DiagnosticSink;
    run?: (
      scenario: ToolAcceptanceCase,
      signal: AbortSignal,
      phase: (value: ToolDiagnosticPhase) => void,
      cleanupFailure: (error: unknown) => void,
    ) => ReturnType<typeof toolScenario>;
  } = {},
) {
  const operation = toolDiagnostics(options.sink).start();
  let phase: ToolDiagnosticPhase = TOOL_DIAGNOSTICS.phases.STARTUP;
  const observe = (next: ToolDiagnosticPhase) => {
    phase = next;
    operation.report({
      phase,
      scenario,
      code: TOOL_DIAGNOSTICS.codes.PROGRESS,
      level: DIAGNOSTIC_LEVELS.DEBUG,
      outcome: DIAGNOSTIC_OUTCOMES.SUCCESS,
    });
  };
  observe(phase);
  try {
    return await (options.run ?? toolScenario)(
      scenario,
      signal,
      observe,
      (error) =>
        operation.report({
          phase: TOOL_DIAGNOSTICS.phases.CLEANUP,
          scenario,
          code: ACCEPTANCE_CODES.FAILED,
          cause: diagnosticCause(error),
          outcome: DIAGNOSTIC_OUTCOMES.CLEANUP_FAILURE,
        }),
    );
  } catch (error) {
    const code =
      error instanceof AcceptanceError
        ? Object.values(ACCEPTANCE_CODES).find((value) => value === error.code)
        : undefined;
    operation.report({
      phase,
      scenario,
      code: code ?? ACCEPTANCE_CODES.FAILED,
      cause: diagnosticCause(error),
      outcome: signal.aborted
        ? DIAGNOSTIC_OUTCOMES.CANCELLED
        : DIAGNOSTIC_OUTCOMES.FAILURE,
    });
    throw error;
  }
}
