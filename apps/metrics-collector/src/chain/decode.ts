// Owns how one finalized transaction (a jsonParsed getTransaction answer) is read: every top-level
// instruction of the payment-channels program with its accounts and arguments, the voucher cumulative
// amount a settle carries in its preceding Ed25519 instruction, the memos, and the net token change per
// owner and mint. The answer is unknown input, checked here; a wrong shape throws ChainShapeError.
import { CHANNEL_PROGRAM } from '@gyblos/config/network';

import {
  CHAIN_ACCOUNTS,
  CHAIN_DISCRIMINATORS,
  CHAIN_INDEX,
  CHAIN_INSTRUCTIONS,
  CHAIN_LAYOUT,
  CHAIN_PROGRAMS,
  type ChainInstructionKind,
} from '../constants';
import { base58Decode, base58Encode } from './base58';
import {
  boundedNum,
  ChainShapeError,
  list,
  nullable,
  record,
  text,
} from './json';

export interface SplitRecipient {
  owner: string;
  bps: number;
}
export interface ChainInstruction {
  index: number;
  kind: ChainInstructionKind;
  channel: string;
  payer: string | null;
  payee: string | null;
  mint: string | null;
  authorizedSigner: string | null;
  // open: the salt (u64 as decimal text) and open slot that, with the parties, derive the channel.
  salt: string | null;
  openSlot: number | null;
  // open: the deposit; top_up: the amount added.
  amountAtomic: bigint | null;
  // settle / settle_and_seal: the signed voucher's cumulative amount, when it carries one.
  cumulativeAtomic: bigint | null;
  // open and distribute: the split recipients in order.
  recipients: SplitRecipient[] | null;
}
export interface TokenDelta {
  owner: string;
  mint: string;
  deltaAtomic: bigint;
}
export interface ChainTransaction {
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  failed: boolean;
  // Program instructions of a successful transaction this decoder could not read.
  undecodable: number;
  instructions: ChainInstruction[];
  memos: string[];
  deltas: TokenDelta[];
}

// Little-endian reads that refuse to run past the data.
class Reader {
  private offset: number;
  constructor(
    private readonly bytes: Uint8Array,
    start: number,
  ) {
    this.offset = start;
  }
  private take(size: number) {
    if (this.offset + size > this.bytes.length)
      throw new ChainShapeError('instruction data too short');
    const at = this.offset;
    this.offset += size;
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + at, size);
  }
  u16 = () => this.take(CHAIN_LAYOUT.u16Bytes).getUint16(0, true);
  u32 = () => this.take(CHAIN_LAYOUT.u32Bytes).getUint32(0, true);
  u64 = () => this.take(CHAIN_LAYOUT.u64Bytes).getBigUint64(0, true);
  pubkey = () => {
    const view = this.take(CHAIN_LAYOUT.pubkeyBytes);
    return base58Encode(
      new Uint8Array(view.buffer, view.byteOffset, CHAIN_LAYOUT.pubkeyBytes),
    );
  };
  recipients = (): SplitRecipient[] =>
    Array.from({ length: this.u32() }, () => ({
      owner: this.pubkey(),
      bps: this.u16(),
    }));
}

const empty = (index: number, kind: ChainInstructionKind, channel: string) => ({
  index,
  kind,
  channel,
  payer: null,
  payee: null,
  mint: null,
  authorizedSigner: null,
  salt: null,
  openSlot: null,
  amountAtomic: null,
  cumulativeAtomic: null,
  recipients: null,
});
function account(accounts: string[], at: number) {
  const value = accounts[at];
  if (value === undefined) throw new ChainShapeError('missing account');
  return value;
}

// The voucher (channel and cumulative amount) an Ed25519 instruction verifies.
export function voucherOf(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  if (data.length < CHAIN_LAYOUT.ed25519MessageOffsetAt + CHAIN_LAYOUT.u16Bytes)
    return null;
  const at = view.getUint16(CHAIN_LAYOUT.ed25519MessageOffsetAt, true);
  const message = data.subarray(at, at + CHAIN_LAYOUT.voucherBytes);
  if (
    message.length < CHAIN_LAYOUT.voucherBytes ||
    message[0] !== CHAIN_LAYOUT.voucherMagic[0] ||
    message[1] !== CHAIN_LAYOUT.voucherMagic[1]
  )
    return null;
  const fields = new DataView(
    message.buffer,
    message.byteOffset,
    message.length,
  );
  return {
    channel: base58Encode(
      message.subarray(
        CHAIN_LAYOUT.voucherChannelAt,
        CHAIN_LAYOUT.voucherChannelAt + CHAIN_LAYOUT.pubkeyBytes,
      ),
    ),
    cumulativeAtomic: fields.getBigUint64(
      CHAIN_LAYOUT.voucherCumulativeAt,
      true,
    ),
  };
}

// open: the parties from its accounts; salt, deposit, grace, open slot and splits from its data.
function decodeOpen(
  index: number,
  reader: Reader,
  accounts: string[],
): ChainInstruction {
  const at = CHAIN_ACCOUNTS.open;
  const salt = reader.u64();
  const deposit = reader.u64();
  reader.u32();
  const openSlot = reader.u64();
  return {
    ...empty(index, CHAIN_INSTRUCTIONS.OPEN, account(accounts, at.channel)),
    payer: account(accounts, at.payer),
    payee: account(accounts, at.payee),
    mint: account(accounts, at.mint),
    authorizedSigner: account(accounts, at.authorizedSigner),
    salt: salt.toString(),
    openSlot: Number(openSlot),
    amountAtomic: deposit,
    recipients: reader.recipients(),
  };
}

// One program instruction; `voucher` is the preceding Ed25519 instruction's voucher, if any.
export function decodeInstruction(
  index: number,
  data: Uint8Array,
  accounts: string[],
  voucher: ReturnType<typeof voucherOf>,
): ChainInstruction | null {
  const kind = CHAIN_DISCRIMINATORS.get(data[0] ?? -1);
  if (!kind) return null;
  const reader = new Reader(data, CHAIN_LAYOUT.discriminatorBytes);
  const cumulative = (channel: string) =>
    voucher && voucher.channel === channel ? voucher.cumulativeAtomic : null;
  switch (kind) {
    case CHAIN_INSTRUCTIONS.OPEN:
      return decodeOpen(index, reader, accounts);
    case CHAIN_INSTRUCTIONS.TOP_UP: {
      const at = CHAIN_ACCOUNTS.topUp;
      return {
        ...empty(index, kind, account(accounts, at.channel)),
        payer: account(accounts, at.payer),
        mint: account(accounts, at.mint),
        amountAtomic: reader.u64(),
      };
    }
    case CHAIN_INSTRUCTIONS.SETTLE: {
      const channel = account(accounts, CHAIN_ACCOUNTS.settle.channel);
      return {
        ...empty(index, kind, channel),
        cumulativeAtomic: cumulative(channel),
      };
    }
    case CHAIN_INSTRUCTIONS.SETTLE_AND_SEAL: {
      const at = CHAIN_ACCOUNTS.settleAndSeal;
      const channel = account(accounts, at.channel);
      // hasVoucher: a zero byte seals at the amount already settled, with no new voucher.
      const hasVoucher = data[CHAIN_LAYOUT.discriminatorBytes] !== 0;
      return {
        ...empty(index, kind, channel),
        payee: account(accounts, at.payee),
        cumulativeAtomic: hasVoucher ? cumulative(channel) : null,
      };
    }
    case CHAIN_INSTRUCTIONS.REQUEST_CLOSE: {
      const at = CHAIN_ACCOUNTS.requestClose;
      return {
        ...empty(index, kind, account(accounts, at.channel)),
        payer: account(accounts, at.payer),
      };
    }
    case CHAIN_INSTRUCTIONS.DISTRIBUTE: {
      const at = CHAIN_ACCOUNTS.distribute;
      return {
        ...empty(index, kind, account(accounts, at.channel)),
        payer: account(accounts, at.payer),
        mint: account(accounts, at.mint),
        recipients: reader.recipients(),
      };
    }
    case CHAIN_INSTRUCTIONS.SEAL:
      return empty(index, kind, account(accounts, CHAIN_ACCOUNTS.seal.channel));
    case CHAIN_INSTRUCTIONS.RECLAIM:
      return empty(
        index,
        kind,
        account(accounts, CHAIN_ACCOUNTS.reclaim.channel),
      );
  }
}

// Net token change per owner and mint across the transaction (post minus pre).
function tokenDeltas(meta: Record<string, unknown>): TokenDelta[] {
  const deltas = new Map<string, TokenDelta>();
  const apply = (balances: unknown, sign: bigint, where: string) => {
    for (const entry of list(balances ?? [], where)) {
      const balance = record(entry, where);
      if (typeof balance.owner !== 'string') continue;
      const mint = text(balance.mint, `${where}.mint`);
      const amount = text(record(balance.uiTokenAmount, where).amount, where);
      const key = `${balance.owner}/${mint}`;
      const delta = deltas.get(key) ?? {
        owner: balance.owner,
        mint,
        deltaAtomic: 0n,
      };
      delta.deltaAtomic += sign * BigInt(amount);
      deltas.set(key, delta);
    }
  };
  apply(meta.preTokenBalances, -1n, 'preTokenBalances');
  apply(meta.postTokenBalances, 1n, 'postTokenBalances');
  return [...deltas.values()].filter((delta) => delta.deltaAtomic !== 0n);
}

// Program instructions in order. The voucher a settle uses is the Ed25519 instruction immediately
// before it (the program reads instruction index - 1). An instruction this decoder cannot read is
// counted, never guessed and never fatal: a successful transaction already passed the program.
function programInstructions(message: Record<string, unknown>) {
  const instructions: ChainInstruction[] = [];
  const memos: string[] = [];
  let undecodable = 0;
  let voucher: { index: number; value: ReturnType<typeof voucherOf> } | null =
    null;
  for (const [index, entry] of list(
    message.instructions,
    'instructions',
  ).entries()) {
    const instruction = record(entry, 'instruction');
    const programId = text(instruction.programId, 'programId');
    if (
      programId === CHAIN_PROGRAMS.MEMO &&
      typeof instruction.parsed === 'string'
    )
      memos.push(instruction.parsed);
    if (typeof instruction.data !== 'string') continue;
    const data = base58Decode(instruction.data);
    if (programId === CHAIN_PROGRAMS.ED25519)
      voucher = { index, value: voucherOf(data) };
    if (programId !== CHANNEL_PROGRAM) continue;
    try {
      const accounts = list(instruction.accounts, 'accounts').map((key) =>
        text(key, 'account'),
      );
      const adjacent = voucher?.index === index - 1 ? voucher.value : null;
      const decoded = decodeInstruction(index, data, accounts, adjacent);
      if (decoded) instructions.push(decoded);
      else undecodable += 1;
    } catch (error) {
      if (!(error instanceof ChainShapeError)) throw error;
      undecodable += 1;
    }
  }
  return { instructions, memos, undecodable };
}

export function decodeTransaction(value: unknown): ChainTransaction {
  const tx = record(value, 'transaction');
  const meta = record(tx.meta, 'meta');
  const transaction = record(tx.transaction, 'transaction.transaction');
  const message = record(transaction.message, 'message');
  const signature = text(
    list(transaction.signatures, 'signatures')[0],
    'signature',
  );
  // A failed transaction changed nothing: its instructions are not read (anyone can send garbage).
  const failed = meta.err !== null && meta.err !== undefined;
  const { instructions, memos, undecodable } = failed
    ? { instructions: [], memos: [], undecodable: 0 }
    : programInstructions(message);
  const blockTime = nullable(tx.blockTime, (present) =>
    boundedNum(present, 'blockTime', 0, CHAIN_INDEX.maxBlockTimeSec),
  );
  return {
    signature,
    slot: boundedNum(tx.slot, 'slot', 0, CHAIN_INDEX.maxSlot),
    blockTimeMs:
      blockTime === null ? null : blockTime * CHAIN_INDEX.msPerSecond,
    failed,
    undecodable,
    instructions,
    memos,
    deltas: failed ? [] : tokenDeltas(meta),
  };
}
