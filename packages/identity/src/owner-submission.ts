// Prepares and sends seller-funded registration exactly once, with bounded finality checks.
// Absence in RPC history is not proof of failure, even after a blockhash expires.
import { setTimeout as delay } from 'node:timers/promises';

import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from '@solana/kit';

import { DEVNET_GENESIS, FINALIZED_COMMITMENT } from '@gyblos/config';

import {
  IDENTITY_RESOLUTION_LIMITS,
  LIMITS,
  OWNER_REGISTRATION_STATUS,
  REGISTRATION_ERROR_LIMITS,
  REGISTRATION_FINAL_FAILURES,
  REGISTRATION_INSTRUCTION_FAILURES,
} from './constants';
import { expiredOwnerRegistration } from './owner-recovery';
import type { OwnerRegistration } from './owner-registration';

export interface PreparedOwnerRegistration {
  wire: Base64EncodedWireTransaction;
  signature: Signature;
  lastValidBlockHeight: bigint;
}
export type OwnerRegistrationSubmission = {
  status: (typeof OWNER_REGISTRATION_STATUS)[keyof typeof OWNER_REGISTRATION_STATUS];
};
export async function prepareOwnerRegistration(
  registration: OwnerRegistration,
): Promise<PreparedOwnerRegistration> {
  const signed = await signTransactionMessageWithSigners(registration.message);
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
    lastValidBlockHeight: registration.lastValidBlockHeight,
  };
}
function boundedInteger(value: unknown, max: bigint): boolean {
  if (typeof value === 'bigint') return value >= 0n && value <= max;
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    BigInt(value) <= max
  );
}
function finalizedFailure(value: unknown): boolean {
  if (typeof value === 'string')
    return REGISTRATION_FINAL_FAILURES.some((item) => item === value);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'InstructionError'
  )
    return false;
  const instruction: unknown = Reflect.get(value, 'InstructionError');
  if (
    !Array.isArray(instruction) ||
    instruction.length !== 2 ||
    !boundedInteger(
      instruction[0],
      REGISTRATION_ERROR_LIMITS.maxInstructionIndex,
    )
  )
    return false;
  const error: unknown = instruction[1];
  if (typeof error === 'string')
    return REGISTRATION_INSTRUCTION_FAILURES.some((item) => item === error);
  return Boolean(
    error &&
    typeof error === 'object' &&
    !Array.isArray(error) &&
    Object.keys(error).join(',') === 'Custom' &&
    boundedInteger(
      Reflect.get(error, 'Custom'),
      REGISTRATION_ERROR_LIMITS.maxCustomError,
    ),
  );
}
async function bounded<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
async function readStatus(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
  signal: AbortSignal,
): Promise<OwnerRegistrationSubmission> {
  const response = await bounded(
    () =>
      rpc
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .send({ abortSignal: signal }),
    signal,
  );
  const status = response.value[0];
  if (
    !status ||
    status.confirmationStatus !== 'finalized' ||
    !Object.hasOwn(status, 'err')
  )
    return { status: OWNER_REGISTRATION_STATUS.UNKNOWN };
  if (status.err === null)
    return { status: OWNER_REGISTRATION_STATUS.CONFIRMED };
  return {
    status: finalizedFailure(status.err)
      ? OWNER_REGISTRATION_STATUS.FAILED
      : OWNER_REGISTRATION_STATUS.UNKNOWN,
  };
}
export async function checkOwnerRegistration(input: {
  rpc: Rpc<SolanaRpcApi>;
  signature: Signature;
  lastValidBlockHeight: bigint;
  attempt?: { asset: Address; blockhash: Blockhash };
}): Promise<OwnerRegistrationSubmission> {
  const unknown = { status: OWNER_REGISTRATION_STATUS.UNKNOWN };
  const rpc = input.rpc;
  const transactionSignature = input.signature;
  const lastValidBlockHeight = input.lastValidBlockHeight;
  const attempt = input.attempt ? { ...input.attempt } : undefined;
  if (lastValidBlockHeight < 0n) return unknown;
  const signal = AbortSignal.timeout(IDENTITY_RESOLUTION_LIMITS.timeoutMs);
  try {
    if (
      (await bounded(
        () => rpc.getGenesisHash().send({ abortSignal: signal }),
        signal,
      )) !== DEVNET_GENESIS
    )
      return unknown;
    const result = await readStatus(rpc, transactionSignature, signal);
    if (result.status !== OWNER_REGISTRATION_STATUS.UNKNOWN || !attempt)
      return result;
    return await bounded(
      () =>
        expiredOwnerRegistration({
          rpc,
          signature: transactionSignature,
          lastValidBlockHeight,
          attempt,
          signal,
        }),
      signal,
    );
  } catch {
    return unknown;
  }
}

// Caller must durably retain the exact prepared bytes, signature, asset and identity before calling.
export async function submitOwnerRegistration(input: {
  rpc: Rpc<SolanaRpcApi>;
  prepared: PreparedOwnerRegistration;
  timeoutMs?: number;
}): Promise<OwnerRegistrationSubmission> {
  const unknown = { status: OWNER_REGISTRATION_STATUS.UNKNOWN };
  const { rpc } = input;
  const prepared = { ...input.prepared };
  const timeoutMs = input.timeoutMs ?? IDENTITY_RESOLUTION_LIMITS.timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > IDENTITY_RESOLUTION_LIMITS.maxTimeoutMs ||
    prepared.lastValidBlockHeight < 0n
  )
    return unknown;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const wire = Uint8Array.from(getBase64Encoder().encode(prepared.wire));
    if (
      wire.length > LIMITS.transactionBytes ||
      Buffer.from(wire).toString('base64') !== prepared.wire
    )
      return unknown;
    const transaction = getTransactionDecoder().decode(wire);
    if (getSignatureFromTransaction(transaction) !== prepared.signature)
      return unknown;
    if (
      (await bounded(
        () => rpc.getGenesisHash().send({ abortSignal: signal }),
        signal,
      )) !== DEVNET_GENESIS
    )
      return unknown;
    const returned = await bounded(
      () =>
        rpc
          .sendTransaction(prepared.wire, {
            encoding: 'base64',
            preflightCommitment: FINALIZED_COMMITMENT,
          })
          .send({ abortSignal: signal }),
      signal,
    );
    if (returned !== prepared.signature) return unknown;
    while (!signal.aborted) {
      const result = await readStatus(rpc, prepared.signature, signal);
      if (result.status !== OWNER_REGISTRATION_STATUS.UNKNOWN) return result;
      await delay(IDENTITY_RESOLUTION_LIMITS.pollIntervalMs, undefined, {
        signal,
      });
    }
  } catch {
    return unknown;
  }
  return unknown;
}
