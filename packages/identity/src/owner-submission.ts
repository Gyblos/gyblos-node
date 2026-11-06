// Prepares and sends seller-funded registration exactly once, with bounded finality checks.
// Absence in RPC history is not proof of failure, even after a blockhash expires.
import { setTimeout as delay } from 'node:timers/promises';

import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransactionMessageWithSigners,
  type Base64EncodedWireTransaction,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from '@solana/kit';

import { DEVNET_GENESIS, FINALIZED_COMMITMENT } from '@gyblos/config';

import {
  IDENTITY_RESOLUTION_LIMITS,
  LIMITS,
  OWNER_REGISTRATION_STATUS,
} from './constants';
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
async function readStatus(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
  signal: AbortSignal,
): Promise<OwnerRegistrationSubmission> {
  const response = await rpc
    .getSignatureStatuses([signature], { searchTransactionHistory: true })
    .send({ abortSignal: signal });
  const status = response.value[0];
  if (
    !status ||
    status.confirmationStatus !== 'finalized' ||
    !Object.hasOwn(status, 'err')
  )
    return { status: OWNER_REGISTRATION_STATUS.UNKNOWN };
  return {
    status:
      status.err === null
        ? OWNER_REGISTRATION_STATUS.CONFIRMED
        : OWNER_REGISTRATION_STATUS.FAILED,
  };
}
export async function checkOwnerRegistration(input: {
  rpc: Rpc<SolanaRpcApi>;
  signature: Signature;
  lastValidBlockHeight: bigint;
}): Promise<OwnerRegistrationSubmission> {
  const unknown = { status: OWNER_REGISTRATION_STATUS.UNKNOWN };
  if (input.lastValidBlockHeight < 0n) return unknown;
  const signal = AbortSignal.timeout(IDENTITY_RESOLUTION_LIMITS.timeoutMs);
  try {
    if (
      (await input.rpc.getGenesisHash().send({ abortSignal: signal })) !==
      DEVNET_GENESIS
    )
      return unknown;
    return await readStatus(input.rpc, input.signature, signal);
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
      (await rpc.getGenesisHash().send({ abortSignal: signal })) !==
      DEVNET_GENESIS
    )
      return unknown;
    const returned = await rpc
      .sendTransaction(prepared.wire, {
        encoding: 'base64',
        preflightCommitment: FINALIZED_COMMITMENT,
      })
      .send({ abortSignal: signal });
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
