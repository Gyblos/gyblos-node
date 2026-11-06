// Proves only that saved bytes expired and their accounts are absent in a sufficiently recent finalized view.
// Missing transaction history alone is never treated as a failed or unpaid registration.
import type {
  Address,
  Blockhash,
  Rpc,
  Signature,
  SolanaRpcApi,
} from '@solana/kit';

import { FINALIZED_COMMITMENT } from '@gyblos/config';

import { METADATA_KEYS, OWNER_REGISTRATION_STATUS } from './constants';
import { findAgentAddress, findMetadataAddress } from './pda';

export async function expiredOwnerRegistration(input: {
  rpc: Rpc<SolanaRpcApi>;
  signature: Signature;
  lastValidBlockHeight: bigint;
  attempt: { asset: Address; blockhash: Blockhash };
  signal: AbortSignal;
}) {
  const { rpc, signal, attempt } = input;
  const send = { abortSignal: signal };
  const unknown = { status: OWNER_REGISTRATION_STATUS.UNKNOWN };
  const statuses = await rpc
    .getSignatureStatuses([input.signature], { searchTransactionHistory: true })
    .send(send);
  if (statuses.value.length !== 1 || statuses.value[0] !== null) return unknown;
  // A retained finalized transaction is stronger evidence than an empty status-cache response.
  const transaction = await rpc
    .getTransaction(input.signature, {
      commitment: FINALIZED_COMMITMENT,
      encoding: 'base64',
      maxSupportedTransactionVersion: 0,
    })
    .send(send);
  if (transaction !== null) return unknown;
  const epoch = await rpc
    .getEpochInfo({ commitment: FINALIZED_COMMITMENT })
    .send(send);
  if (
    typeof epoch.blockHeight !== 'bigint' ||
    typeof epoch.absoluteSlot !== 'bigint' ||
    epoch.absoluteSlot < 0n ||
    epoch.blockHeight <= input.lastValidBlockHeight
  )
    return unknown;
  const options = {
    commitment: FINALIZED_COMMITMENT,
    minContextSlot: epoch.absoluteSlot,
  };
  const valid = await rpc
    .isBlockhashValid(attempt.blockhash, options)
    .send(send);
  if (
    typeof valid.context.slot !== 'bigint' ||
    valid.context.slot < epoch.absoluteSlot ||
    valid.value !== false
  )
    return unknown;
  const addresses = [
    attempt.asset,
    await findAgentAddress(attempt.asset),
    await findMetadataAddress(attempt.asset, METADATA_KEYS.nodeId),
  ];
  const accounts = await rpc
    .getMultipleAccounts(addresses, { ...options, encoding: 'base64' })
    .send(send);
  if (
    typeof accounts.context.slot !== 'bigint' ||
    accounts.context.slot < epoch.absoluteSlot ||
    accounts.value.length !== addresses.length ||
    accounts.value.some((value) => value !== null)
  )
    return unknown;
  return { status: OWNER_REGISTRATION_STATUS.EXPIRED };
}
