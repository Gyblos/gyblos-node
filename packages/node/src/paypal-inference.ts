// Coordinates one sandbox purchase with one bounded inference; the payment and engine are injected.
// The journal contains only payment metadata and a prompt digest, never prompts or responses.
import { createHash } from 'node:crypto';

const PHASE = {
  CREATING: 'creating',
  CREATED: 'created',
  AUTHORIZING: 'authorizing',
  EXECUTING: 'executing',
  CAPTURING: 'capturing',
  COMPLETED: 'completed',
  VOIDING: 'voiding',
  VOIDED: 'voided',
} as const;
const REQUEST_LIMITS = { maxTokens: 256, promptBytes: 8192 } as const;
type Phase = (typeof PHASE)[keyof typeof PHASE];

interface Attempt {
  phase: Phase;
  promptDigest: string;
  maxTokens: number;
  orderId?: string;
  authorizationId?: string;
  captureId?: string;
}

export interface PaypalInferenceDependencies {
  payment: {
    create(): Promise<{ orderId: string; approvalUrl: string }>;
    authorize(orderId: string): Promise<{ authorizationId: string }>;
    capture(authorizationId: string): Promise<{ captureId: string }>;
    void(authorizationId: string): Promise<void>;
  };
  journal: {
    read(): Promise<unknown>;
    write(value: Attempt): Promise<void>;
  };
  engine: {
    generate(input: { prompt: string; maxTokens: number }): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number };
    }>;
  };
}

function parseAttempt(value: unknown): Attempt | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid payment journal');
  const entry = Object.fromEntries(Object.entries(value));
  if (
    !Object.values(PHASE).some((phase) => phase === entry.phase) ||
    typeof entry.promptDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.promptDigest) ||
    !Number.isSafeInteger(entry.maxTokens) ||
    typeof entry.maxTokens !== 'number' ||
    entry.maxTokens < 1 ||
    entry.maxTokens > REQUEST_LIMITS.maxTokens ||
    ['orderId', 'authorizationId', 'captureId'].some(
      (key) => entry[key] !== undefined && typeof entry[key] !== 'string',
    )
  )
    throw new Error('Invalid payment journal');
  const phase = Object.values(PHASE).find((item) => item === entry.phase);
  if (!phase) throw new Error('Invalid payment journal');
  if (
    (phase !== PHASE.CREATING && typeof entry.orderId !== 'string') ||
    ([
      PHASE.EXECUTING,
      PHASE.CAPTURING,
      PHASE.COMPLETED,
      PHASE.VOIDING,
      PHASE.VOIDED,
    ].some((item) => item === phase) &&
      typeof entry.authorizationId !== 'string') ||
    (phase === PHASE.COMPLETED && typeof entry.captureId !== 'string')
  )
    throw new Error('Invalid payment journal');
  return {
    phase,
    promptDigest: entry.promptDigest,
    maxTokens: entry.maxTokens,
    ...(typeof entry.orderId === 'string' ? { orderId: entry.orderId } : {}),
    ...(typeof entry.authorizationId === 'string'
      ? { authorizationId: entry.authorizationId }
      : {}),
    ...(typeof entry.captureId === 'string'
      ? { captureId: entry.captureId }
      : {}),
  };
}

function digest(prompt: string, maxTokens: number): string {
  if (
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    Buffer.byteLength(prompt, 'utf8') > REQUEST_LIMITS.promptBytes ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > REQUEST_LIMITS.maxTokens
  )
    throw new Error('Invalid inference request');
  return createHash('sha256')
    .update(JSON.stringify({ prompt, maxTokens }))
    .digest('hex');
}

async function generateOrVoid(
  deps: PaypalInferenceDependencies,
  save: (attempt: Attempt) => Promise<void>,
  authorized: Attempt,
  authorizationId: string,
  prompt: string,
  maxTokens: number,
) {
  try {
    return await deps.engine.generate({ prompt, maxTokens });
  } catch {
    await save({ ...authorized, phase: PHASE.VOIDING });
    await deps.payment.void(authorizationId);
    await save({ ...authorized, phase: PHASE.VOIDED });
    throw new Error('Inference failed');
  }
}

function isFinished(attempt: Attempt | null) {
  return (
    !attempt ||
    attempt.phase === PHASE.COMPLETED ||
    attempt.phase === PHASE.VOIDED
  );
}

export async function createPaypalInference(deps: PaypalInferenceDependencies) {
  let active = parseAttempt(await deps.journal.read());
  let busy = false;
  let journalFailed = false;
  async function save(attempt: Attempt) {
    active = attempt;
    try {
      await deps.journal.write(attempt);
    } catch (error) {
      journalFailed = true;
      throw error;
    }
  }
  return {
    async create(prompt: string, maxTokens: number) {
      const promptDigest = digest(prompt, maxTokens);
      if (busy || journalFailed || !isFinished(active))
        throw new Error('Payment needs reconciliation');
      busy = true;
      try {
        await save({ phase: PHASE.CREATING, promptDigest, maxTokens });
        const order = await deps.payment.create();
        await save({
          phase: PHASE.CREATED,
          promptDigest,
          maxTokens,
          orderId: order.orderId,
        });
        return order;
      } finally {
        busy = false;
      }
    },
    async execute(orderId: string, prompt: string, maxTokens: number) {
      const promptDigest = digest(prompt, maxTokens);
      if (
        busy ||
        journalFailed ||
        !active ||
        active.phase !== PHASE.CREATED ||
        active.orderId !== orderId ||
        active.promptDigest !== promptDigest ||
        active.maxTokens !== maxTokens
      )
        throw new Error('Payment attempt cannot be executed');
      busy = true;
      try {
        const attempt = active;
        await save({ ...attempt, phase: PHASE.AUTHORIZING });
        const authorization = await deps.payment.authorize(orderId);
        const authorized = {
          ...attempt,
          ...authorization,
          phase: PHASE.EXECUTING,
        };
        await save(authorized);
        const output = await generateOrVoid(
          deps,
          save,
          authorized,
          authorization.authorizationId,
          prompt,
          maxTokens,
        );
        await save({ ...authorized, phase: PHASE.CAPTURING });
        const capture = await deps.payment.capture(
          authorization.authorizationId,
        );
        await save({ ...authorized, ...capture, phase: PHASE.COMPLETED });
        return output;
      } finally {
        busy = false;
      }
    },
  };
}
