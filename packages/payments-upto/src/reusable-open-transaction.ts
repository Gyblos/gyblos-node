// Checks the exact unsigned SDK message and derives its channel before a buyer signs the opening.
// The binary layout is pinned to the payment-channel program and does not send the transaction.
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getU64Encoder,
  getUtf8Encoder,
} from '@solana/kit';
import { DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS } from '@x402/svm';

import { CHANNEL_PROGRAM } from '@gyblos/config';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import { REUSABLE_JOURNAL, REUSABLE_OPEN_WIRE } from './constants';
import {
  parseTerms,
  unavailable,
  type ReusableChannelTerms,
} from './reusable-journal-model';
import { reusableOpeningMemo } from './reusable-opening-memo';

function sameAddresses(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
async function channelPda(
  terms: ReusableChannelTerms,
  salt: bigint,
): Promise<string> {
  const encode = getAddressEncoder();
  const integer = getU64Encoder();
  const [derived] = await getProgramDerivedAddress({
    programAddress: address(CHANNEL_PROGRAM),
    seeds: [
      getUtf8Encoder().encode(REUSABLE_OPEN_WIRE.seed),
      encode.encode(address(terms.buyer)),
      encode.encode(address(terms.feePayer)),
      encode.encode(address(terms.mint)),
      encode.encode(address(terms.buyer)),
      integer.encode(salt),
      integer.encode(BigInt(terms.openSlot)),
    ],
  });
  return derived;
}
function checkData(data: Uint8Array, terms: ReusableChannelTerms): bigint {
  const spec = REUSABLE_OPEN_WIRE;
  if (data.length < spec.recipientsOffset || data[0] !== spec.discriminator)
    unavailable();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const salt = view.getBigUint64(spec.saltOffset, true);
  const count = view.getUint32(spec.countOffset, true);
  const splits = paymentSplits(terms);
  if (
    view.getBigUint64(spec.depositOffset, true) !==
      BigInt(terms.depositAtomic) ||
    view.getUint32(spec.graceOffset, true) !== terms.gracePeriod ||
    view.getBigUint64(spec.slotOffset, true) !== BigInt(terms.openSlot) ||
    count !== splits.length ||
    data.length !== spec.recipientsOffset + count * spec.recipientBytes
  )
    unavailable();
  const decoder = getAddressDecoder();
  for (const [index, split] of splits.entries()) {
    const start = spec.recipientsOffset + index * spec.recipientBytes;
    if (
      String(
        decoder.decode(
          data.subarray(start, start + REUSABLE_JOURNAL.addressBytes),
        ),
      ) !== split.recipient ||
      view.getUint16(start + REUSABLE_JOURNAL.addressBytes, true) !== split.bps
    )
      unavailable();
  }
  return salt;
}
function checkBudget(data: Uint8Array): 'limit' | 'price' {
  const spec = REUSABLE_OPEN_WIRE;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (
    data.length === spec.computeLimitBytes &&
    data[0] === spec.computeLimitTag &&
    view.getUint32(1, true) === REUSABLE_OPEN_WIRE.computeLimit
  )
    return 'limit';
  if (
    data.length === spec.computePriceBytes &&
    data[0] === spec.computePriceTag &&
    view.getBigUint64(1, true) ===
      BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS)
  )
    return 'price';
  return unavailable();
}
export async function openingTermsFromMessage(
  bytes: Uint8Array,
  provisional: ReusableChannelTerms,
): Promise<ReusableChannelTerms> {
  const message = getCompiledTransactionMessageDecoder().decode(bytes);
  const keys = message.staticAccounts.map(String);
  if (
    message.lifetimeToken !== provisional.recentBlockhash ||
    keys[0] !== provisional.feePayer
  )
    unavailable();
  const open = message.instructions.filter(
    (instruction) => keys[instruction.programAddressIndex] === CHANNEL_PROGRAM,
  );
  const memos = message.instructions.filter(
    (instruction) =>
      keys[instruction.programAddressIndex] === REUSABLE_OPEN_WIRE.memoProgram,
  );
  if (
    open.length !== 1 ||
    memos.length !== 1 ||
    message.instructions.some(
      (instruction) =>
        ![
          CHANNEL_PROGRAM,
          REUSABLE_OPEN_WIRE.memoProgram,
          REUSABLE_OPEN_WIRE.computeBudgetProgram,
        ].includes(keys[instruction.programAddressIndex] ?? ''),
    )
  )
    unavailable();
  const budgets = message.instructions.filter(
    (instruction) =>
      keys[instruction.programAddressIndex] ===
      REUSABLE_OPEN_WIRE.computeBudgetProgram,
  );
  if (
    budgets.length !== 2 ||
    message.instructions.length !== REUSABLE_OPEN_WIRE.instructionCount
  )
    unavailable();
  const kinds = budgets.map((instruction) => {
    if (!instruction.data || (instruction.accountIndices?.length ?? 0) !== 0)
      return unavailable();
    return checkBudget(Uint8Array.from(instruction.data));
  });
  if (!kinds.includes('limit') || !kinds.includes('price')) unavailable();
  const instruction = open[0];
  const memo = memos[0];
  if (
    !instruction?.data ||
    !instruction.accountIndices ||
    !memo?.data ||
    new TextDecoder('utf-8', { fatal: true }).decode(memo.data) !==
      (await reusableOpeningMemo(provisional))
  )
    unavailable();
  const accounts = instruction.accountIndices.map((index) => keys[index] ?? '');
  if (
    !sameAddresses(accounts.slice(0, REUSABLE_OPEN_WIRE.channelAccountIndex), [
      provisional.buyer,
      provisional.feePayer,
      provisional.feePayer,
      provisional.mint,
      provisional.buyer,
    ]) ||
    accounts[REUSABLE_OPEN_WIRE.tokenProgramAccountIndex] !==
      provisional.tokenProgram
  )
    unavailable();
  const salt = checkData(Uint8Array.from(instruction.data), provisional);
  const channelId = await channelPda(provisional, salt);
  if (accounts[REUSABLE_OPEN_WIRE.channelAccountIndex] !== channelId)
    unavailable();
  return parseTerms({ ...provisional, channelId, salt: String(salt) });
}
