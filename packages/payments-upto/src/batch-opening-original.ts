import {
  address,
  assertIsSignatureBytes,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getU64Encoder,
  getUtf8Encoder,
  verifySignature,
} from '@solana/kit';

import { canonicalJson } from '@gyblos/protocol';
import { controlObject } from '@gyblos/protocol/control-validation';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { buildBuyerOpening } from './batch-opening-build';
import { openingMessage } from './batch-opening-proof';
import type { BatchBuyerOptions, BatchRecord } from './batch-session-types';
import { BATCH_BUYER_CHECKPOINTS, BATCH_OPENING_LIMITS } from './constants';

const CHANNEL_SEED = 'channel';

async function unsignedOpeningMessage(record: BatchRecord) {
  const stop = new Error('Opening message captured');
  let captured: Uint8Array | undefined;
  const capture: BatchBuyerOptions['payer'] = {
    address: address(record.terms.buyer),
    async signTransactions(transactions) {
      const transaction = transactions[0];
      if (captured || transactions.length !== 1 || !transaction)
        return sessionFail(SESSION_CODES.BINDING);
      captured = Uint8Array.from(transaction.messageBytes);
      throw stop;
    },
    async signMessages() {
      return sessionFail(SESSION_CODES.BINDING);
    },
  };
  try {
    await buildBuyerOpening(record, capture);
  } catch (error) {
    if (error !== stop) throw error;
  }
  if (!captured) return sessionFail(SESSION_CODES.UNVERIFIED);
  return captured;
}

async function openedChannel(
  record: BatchRecord,
  slot: string,
  message: Uint8Array,
) {
  const compiled = getCompiledTransactionMessageDecoder().decode(message);
  const accounts = compiled.staticAccounts;
  const encode = getAddressEncoder();
  const seeds = [
    getUtf8Encoder().encode(CHANNEL_SEED),
    encode.encode(address(record.terms.buyer)),
    encode.encode(address(record.terms.feePayer)),
    encode.encode(address(record.terms.mint)),
    encode.encode(address(record.terms.buyer)),
    getU64Encoder().encode(BigInt(record.salt)),
    getU64Encoder().encode(BigInt(slot)),
  ];
  for (const instruction of compiled.instructions) {
    const program = accounts[instruction.programAddressIndex];
    if (!program) continue;
    const [channel] = await getProgramDerivedAddress({
      programAddress: program,
      seeds,
    });
    if (
      instruction.accountIndices?.some((index) => accounts[index] === channel)
    )
      return channel;
  }
  return sessionFail(SESSION_CODES.BINDING);
}

function channelConfig(record: BatchRecord, slot: string) {
  return {
    openSlot: Number(slot),
    payer: record.terms.buyer,
    payerAuthorizer: record.terms.buyer,
    receiver: record.terms.payTo,
    receiverAuthorizer: record.terms.authorizer,
    salt: BigInt(record.salt).toString(),
    token: record.terms.mint,
    withdrawDelay: record.terms.withdrawDelaySeconds,
  };
}

export async function originalBatchOpening(record: BatchRecord) {
  const slot = record.hints?.slot;
  if (slot === undefined) return sessionFail(SESSION_CODES.UNVERIFIED);
  const original = openingMessage(record);
  if (original.length > BATCH_OPENING_LIMITS.bytes)
    return sessionFail(SESSION_CODES.LIMIT);
  const expected = await unsignedOpeningMessage(record);
  if (!Buffer.from(original).equals(Buffer.from(expected)))
    return sessionFail(SESSION_CODES.BINDING);
  const channelId = await openedChannel(record, slot, expected);
  if (
    (record.channelId !== '' && record.channelId !== channelId) ||
    (record.opening &&
      canonicalJson(record.opening.channelConfig) !==
        canonicalJson(channelConfig(record, slot)))
  )
    return sessionFail(SESSION_CODES.BINDING);
  let signed;
  if (record.opening)
    signed = getTransactionDecoder().decode(
      Buffer.from(record.opening.deposit.transaction, 'base64'),
    ).signatures[address(record.terms.buyer)];
  else {
    const row = controlObject(
      JSON.parse(record.pending[BATCH_BUYER_CHECKPOINTS.OPENING_TRANSACTION]!),
      ['message', 'signature'],
    );
    if (row.signature !== null) {
      if (typeof row.signature !== 'string')
        return sessionFail(SESSION_CODES.UNVERIFIED);
      const bytes = Buffer.from(row.signature, 'base64');
      if (bytes.toString('base64') !== row.signature)
        return sessionFail(SESSION_CODES.UNVERIFIED);
      const signature = Uint8Array.from(bytes);
      assertIsSignatureBytes(signature);
      signed = signature;
    }
  }
  if (
    signed &&
    !(await verifySignature(
      await getPublicKeyFromAddress(address(record.terms.buyer)),
      signed,
      original,
    ))
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (record.opening && !signed) return sessionFail(SESSION_CODES.UNVERIFIED);
  return { channelId, message: original };
}
