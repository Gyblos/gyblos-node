import { randomUUID } from 'node:crypto';

import { isAddress, isSignature } from '@solana/kit';
import {
  FacilitatorTimeoutError,
  SettleError,
  VerifyError,
} from '@x402/core/types';
import { TransactionOnchainFailureError } from '@x402/svm';
import {
  ChannelOpenConfirmationError,
  ErrSettlementPending,
  SettlementConfirmationTimeoutError,
  SettlementSimulationError,
} from '@x402/svm/upto/facilitator';

import { X402_SDK_VERSION } from '@gyblos/config';

import {
  FACILITATOR_DIAGNOSTIC_CODES,
  FACILITATOR_DIAGNOSTIC_SCHEMA,
  FACILITATOR_PHASES,
  FACILITATOR_STAGES,
  MAX_ATOMIC,
  PUBLIC_CALL_OPERATIONS,
  type FacilitatorDiagnosticCode,
  type FacilitatorPhase,
  type FacilitatorStage,
  type PublicCallOperation,
} from './constants.js';

export interface FacilitatorDiagnosticRecord {
  schemaVersion: typeof FACILITATOR_DIAGNOSTIC_SCHEMA;
  sdkVersion: string;
  instanceId: string;
  attemptId: string;
  sequence: number;
  recordedAt: string;
  elapsedMs: number;
  operation: PublicCallOperation;
  phase: FacilitatorPhase;
  stage: FacilitatorStage;
  channelId?: string;
  amountAtomic?: string;
  sdkSuccess?: boolean;
  code?: FacilitatorDiagnosticCode;
  transaction?: string;
  httpStatus?: number;
}

export interface FacilitatorDiagnosticOptions {
  onDiagnostic?: (record: FacilitatorDiagnosticRecord) => void | Promise<void>;
}

interface Context {
  phase: FacilitatorPhase;
  channelId?: string;
  amountAtomic?: string;
}

interface Detail {
  sdkSuccess?: boolean;
  code?: FacilitatorDiagnosticCode;
  transaction?: string;
  httpStatus?: number;
}

function field(value: unknown, key: string): unknown {
  try {
    if (typeof value === 'object' && value !== null)
      return Reflect.get(value, key);
  } catch {
    // Never coerce or serialize a hostile SDK property.
  }
  return undefined;
}

function signature(value: unknown): string | undefined {
  return typeof value === 'string' && isSignature(value) ? value : undefined;
}

function reason(value: unknown): FacilitatorDiagnosticCode {
  if (value === ErrSettlementPending)
    return FACILITATOR_DIAGNOSTIC_CODES.SETTLEMENT_PENDING;
  if (value === 'transaction_failed')
    return FACILITATOR_DIAGNOSTIC_CODES.TRANSACTION_FAILED;
  if (value === 'invalid_upto_svm_settlement_simulation')
    return FACILITATOR_DIAGNOSTIC_CODES.SIMULATION_REJECTED;
  return FACILITATOR_DIAGNOSTIC_CODES.SDK_REJECTED;
}

function context(payload: unknown, requirements: unknown): Context {
  const payment = field(payload, 'payload');
  const phase = field(payment, 'type');
  const channelId = field(payment, 'channelId');
  const amount = field(requirements, 'amount');
  return {
    phase:
      phase === FACILITATOR_PHASES.DEPOSIT || phase === FACILITATOR_PHASES.CLAIM
        ? phase
        : FACILITATOR_PHASES.UNKNOWN,
    channelId:
      typeof channelId === 'string' && isAddress(channelId)
        ? channelId
        : undefined,
    amountAtomic:
      typeof amount === 'string' &&
      amount.length <= MAX_ATOMIC.length &&
      /^(0|[1-9][0-9]*)$/.test(amount) &&
      BigInt(amount) <= BigInt(MAX_ATOMIC)
        ? amount
        : undefined,
  };
}

function resultDetail(operation: PublicCallOperation, result: unknown): Detail {
  const success = field(
    result,
    operation === PUBLIC_CALL_OPERATIONS.VERIFY ? 'isValid' : 'success',
  );
  const candidate = field(
    result,
    operation === PUBLIC_CALL_OPERATIONS.VERIFY
      ? 'invalidReason'
      : 'errorReason',
  );
  return {
    sdkSuccess: typeof success === 'boolean' ? success : undefined,
    code: success === false ? reason(candidate) : undefined,
    transaction: signature(field(result, 'transaction')),
  };
}

function exceptionDetail(error: unknown): Detail {
  try {
    if (
      error instanceof SettlementConfirmationTimeoutError ||
      error instanceof ChannelOpenConfirmationError
    )
      return {
        code: FACILITATOR_DIAGNOSTIC_CODES.CONFIRMATION_UNKNOWN,
        transaction: signature(field(error, 'signature')),
      };
    if (error instanceof SettlementSimulationError)
      return { code: FACILITATOR_DIAGNOSTIC_CODES.SIMULATION_REJECTED };
    if (error instanceof TransactionOnchainFailureError)
      return { code: FACILITATOR_DIAGNOSTIC_CODES.TRANSACTION_FAILED };
    if (error instanceof FacilitatorTimeoutError)
      return { code: FACILITATOR_DIAGNOSTIC_CODES.TIMEOUT };
    if (error instanceof SettleError)
      return {
        code: reason(field(error, 'errorReason')),
        transaction: signature(field(error, 'transaction')),
      };
    if (error instanceof VerifyError)
      return { code: reason(field(error, 'invalidReason')) };
    const name = field(error, 'name');
    if (name === 'AbortError')
      return { code: FACILITATOR_DIAGNOSTIC_CODES.ABORTED };
    if (name === 'TimeoutError')
      return { code: FACILITATOR_DIAGNOSTIC_CODES.TIMEOUT };
  } catch {
    // Prototype traps must not prevent recording a conservative exception code.
  }
  return { code: FACILITATOR_DIAGNOSTIC_CODES.SDK_EXCEPTION };
}

export function createFacilitatorObserver(
  options: FacilitatorDiagnosticOptions = {},
) {
  const instanceId = randomUUID();
  let sequence = 0;
  return (operation: PublicCallOperation) => {
    const attemptId = randomUUID();
    const startedAt = performance.now();
    let identity: Context = { phase: FACILITATOR_PHASES.UNKNOWN };
    const record = (stage: FacilitatorStage, detail: Detail = {}) => {
      const projected: FacilitatorDiagnosticRecord = Object.freeze({
        schemaVersion: FACILITATOR_DIAGNOSTIC_SCHEMA,
        sdkVersion: X402_SDK_VERSION,
        instanceId,
        attemptId,
        sequence: ++sequence,
        recordedAt: new Date().toISOString(),
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        operation,
        stage,
        ...identity,
        ...detail,
      });
      try {
        Promise.resolve(options.onDiagnostic?.(projected)).catch(() => {});
      } catch {
        // Observers cannot replace a payment result or trigger a payment retry.
      }
    };
    record(FACILITATOR_STAGES.RECEIVED);
    return {
      identify(payload: unknown, requirements: unknown) {
        identity = context(payload, requirements);
      },
      record,
      result(result: unknown) {
        record(FACILITATOR_STAGES.SDK_RESULT, resultDetail(operation, result));
      },
      exception(error: unknown) {
        record(FACILITATOR_STAGES.SDK_EXCEPTION, exceptionDetail(error));
      },
    };
  };
}
