// The port every seller execution passes through, free or paid. A policy decides what a verified and
// metered request may consume (admit), records once what was actually delivered (finish) and frees the
// generation slot (release). Free policies keep every admission check and skip only money; a payment
// policy keeps deposits, settlement and recovery behind its own adapter. Types only.

// What a policy authorizes for one admitted request.
export interface ExecutionPermit<State> {
  // Output token ceiling: the request's own maxTokens when free, what the deposit pays for when paid.
  // The adapter bounds the engine and its stream by it; the lifecycle does not enforce it.
  readonly outputTokens: number;
  // Epoch milliseconds after which generation must stop, reserving the policy's settlement time.
  readonly deadline?: number;
  // The policy's private state (a cap lease, a payment admission). Execution never reads it.
  readonly state: State;
}

// What the seller actually delivered, measured by its own meter, including after a cut or timeout.
export interface ExecutionOutcome {
  readonly inputTokens: number;
  readonly outputTokens: number;
  // Whether the engine finished normally. A policy may charge partial output regardless (paid charges
  // delivered tokens); free refunds unused reservations only for a completed sale.
  readonly completed: boolean;
}

export interface ExecutionPolicy<Request, Context, State, Settlement> {
  // Before generation; identity and signatures are already verified. A refusal here charges nothing.
  admit(request: Request, context: Context): Promise<ExecutionPermit<State>>;
  // Exactly once per permit, even when the request was cut or cancelled. It runs on the service's
  // lifetime, never the request's signal: cancelling a prompt does not cancel what it consumed.
  finish(
    permit: ExecutionPermit<State>,
    outcome: ExecutionOutcome,
  ): Promise<Settlement>;
  // Frees the generation slot. Idempotent; it never discards a financial obligation.
  release(permit: ExecutionPermit<State>): void;
}
