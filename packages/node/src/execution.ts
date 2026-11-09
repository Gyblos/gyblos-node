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
  type GenerationWindow,
  type GenerationWindowErrors,
} from './generation-window';

export type Generated<T> = { value: T } | { error: unknown };

// One generation, opened inside the window so its output can watch the window's signal and deadline.
export interface ExecutionSession<T> {
  generate: () => Promise<T>;
  // Stops publication when the deadline expires while the engine still runs.
  stop?: () => void;
  // What was delivered, for the result or the failure. If it throws, nothing counts as delivered and
  // the run reports the measuring error instead of the result: a seller bug never charges the buyer.
  measure: (generated: Generated<T>) => ExecutionOutcome;
}

export interface AdmittedExecution<State, Settlement, T> {
  policy: Pick<
    ExecutionPolicy<never, never, State, Settlement>,
    'finish' | 'release'
  >;
  permit: ExecutionPermit<State>;
  now: () => number;
  signal: AbortSignal;
  errors: GenerationWindowErrors;
  open: (
    window: Pick<GenerationWindow, 'signal' | 'check'>,
  ) => ExecutionSession<T>;
  // The outcome that charges nothing, when opening, generating or measuring failed unexpectedly.
  nothing: ExecutionOutcome;
}

export interface ExecutionResult<Settlement, T> {
  generated: Generated<T>;
  outcome: ExecutionOutcome;
  settlement: Settlement;
}

async function generateAndMeasure<State, Settlement, T>(
  execution: AdmittedExecution<State, Settlement, T>,
) {
  const window = generationWindow(
    execution.permit.deadline,
    execution.now,
    execution.signal,
    execution.errors,
  );
  const session = execution.open(window);
  const generated: Generated<T> = await window
    .run(session.generate, () => session.stop?.())
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  return { generated, outcome: session.measure(generated) };
}

export async function runAdmittedExecution<State, Settlement, T>(
  execution: AdmittedExecution<State, Settlement, T>,
): Promise<ExecutionResult<Settlement, T>> {
  let generated: Generated<T>;
  let outcome: ExecutionOutcome;
  try {
    ({ generated, outcome } = await generateAndMeasure(execution));
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
