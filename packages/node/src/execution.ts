// The one lifecycle every admitted seller execution follows, free or paid: generate within the permit's
// deadline, measure what was delivered, let the policy finish exactly once and always release the slot.
// A cancelled or failed generation still finishes: what was delivered is recorded, never forgotten.
// No wire formats, files or payments here; adapters own parsing, codes and responses.
import type {
  ExecutionOutcome,
  ExecutionPermit,
  ExecutionPolicy,
} from '@gyblos/protocol/execution-policy';

import {
  generationWindow,
  type GenerationWindowErrors,
} from './generation-window';

export type Generated<T> = { value: T } | { error: unknown };

export interface AdmittedExecution<State, Settlement, T> {
  policy: Pick<
    ExecutionPolicy<never, never, State, Settlement>,
    'finish' | 'release'
  >;
  permit: ExecutionPermit<State>;
  now: () => number;
  signal: AbortSignal;
  errors: GenerationWindowErrors;
  // Runs the engine within the window's signal; check() throws once the deadline passed.
  generate: (signal: AbortSignal, check: () => void) => Promise<T>;
  // Stops publication when the deadline expires while the engine still runs.
  stop?: () => void;
  // What was delivered, for the result or the failure; a measuring bug counts as nothing delivered.
  measure: (generated: Generated<T>, signal: AbortSignal) => ExecutionOutcome;
  // The outcome that charges nothing, when generation or measuring failed unexpectedly.
  nothing: ExecutionOutcome;
}

export interface ExecutionResult<Settlement, T> {
  generated: Generated<T>;
  outcome: ExecutionOutcome;
  settlement: Settlement;
}

async function generateWithin<State, Settlement, T>(
  execution: AdmittedExecution<State, Settlement, T>,
) {
  const window = generationWindow(
    execution.permit.deadline,
    execution.now,
    execution.signal,
    execution.errors,
  );
  const generated: Generated<T> = await window
    .run(
      () => execution.generate(window.signal, window.check),
      () => execution.stop?.(),
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  return { generated, signal: window.signal };
}

export async function runAdmittedExecution<State, Settlement, T>(
  execution: AdmittedExecution<State, Settlement, T>,
): Promise<ExecutionResult<Settlement, T>> {
  let generated: Generated<T>;
  let outcome: ExecutionOutcome;
  try {
    const run = await generateWithin(execution);
    generated = run.generated;
    outcome = execution.measure(generated, run.signal);
  } catch (error) {
    generated = { error };
    outcome = execution.nothing;
  }
  try {
    const settlement = await execution.policy.finish(execution.permit, outcome);
    return { generated, outcome, settlement };
  } finally {
    execution.policy.release(execution.permit);
  }
}
