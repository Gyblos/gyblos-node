// Owns how one finalized Solana transaction of the payment-channels program is read as a Gyblos
// settlement: who paid, who was paid, the Gyblos fee, the program residual and the refund. The
// transaction is checked at the boundary. Pure, no I/O.
import { CHANNEL_PROGRAM, GYBLOS_TREASURY, PROGRAM_TREASURY } from './config';
import { SETTLEMENT_KINDS, SOLANA_RPC, type SettlementKind } from './constants';
import { list, nullable, num, record, text, type JsonRecord } from './validate';

export interface Settlement {
  signature: string;
  slot: number;
  blockTime: number | null;
  kind: SettlementKind;
  payer: string | null;
  seller: string | null;
  // Atomic units (6 decimals for the devnet test USDC mints).
  sellerAtomic: bigint;
  feeAtomic: bigint;
  residualAtomic: bigint;
  refundAtomic: bigint;
  mint: string | null;
}

// Net token change per owner across the transaction, and the first mint seen after it.
function balanceDeltas(meta: JsonRecord) {
  const deltas = new Map<string, bigint>();
  let mint: string | null = null;
  const apply = (balances: unknown, sign: bigint, where: string) => {
    for (const entry of list(balances ?? [], where)) {
      const balance = record(entry, where);
      if (typeof balance.owner !== 'string') continue;
      const amount = text(record(balance.uiTokenAmount, where).amount, where);
      if (sign > 0n) mint ??= text(balance.mint, `${where}.mint`);
      deltas.set(
        balance.owner,
        (deltas.get(balance.owner) ?? 0n) + sign * BigInt(amount),
      );
    }
  };
  apply(meta.preTokenBalances, -1n, 'preTokenBalances');
  apply(meta.postTokenBalances, 1n, 'postTokenBalances');
  return { deltas, mint };
}

// The payer of the channel instruction, or undefined when the transaction has none.
function channelPayer(transaction: JsonRecord): string | null | undefined {
  const message = record(transaction.message, 'message');
  for (const entry of list(message.instructions, 'instructions')) {
    const instruction = record(entry, 'instruction');
    const accounts = list(instruction.accounts ?? [], 'accounts');
    if (
      instruction.programId === CHANNEL_PROGRAM &&
      accounts.length > SOLANA_RPC.minChannelAccounts
    ) {
      const payer = accounts[SOLANA_RPC.payerAccountIndex];
      return typeof payer === 'string' ? payer : null;
    }
  }
  return undefined;
}

// The payee: every positive delta that is neither the payer nor a treasury.
function sellerShare(deltas: Map<string, bigint>, payer: string | null) {
  let seller: string | null = null;
  let sellerAtomic = 0n;
  for (const [owner, delta] of deltas) {
    if (delta <= 0n) continue;
    if (
      owner === GYBLOS_TREASURY ||
      owner === PROGRAM_TREASURY ||
      owner === payer
    )
      continue;
    sellerAtomic += delta;
    seller ??= owner;
  }
  return { seller, sellerAtomic };
}

// A successful channel transaction as a settlement, or null for anything else.
export function classify(value: unknown): Settlement | null {
  if (value === null) return null;
  const tx = record(value, 'transaction');
  const meta = nullable(tx.meta, (present) => record(present, 'meta'));
  const transaction = record(tx.transaction, 'transaction.transaction');
  const signature = list(transaction.signatures, 'signatures')[0];
  if (!meta || meta.err || typeof signature !== 'string') return null;
  const payer = channelPayer(transaction);
  if (payer === undefined) return null;
  const { deltas, mint } = balanceDeltas(meta);
  const feeAtomic = deltas.get(GYBLOS_TREASURY) ?? 0n;
  const payerDelta = payer ? (deltas.get(payer) ?? 0n) : 0n;
  return {
    signature,
    slot: num(tx.slot, 'slot'),
    blockTime: nullable(tx.blockTime, (present) => num(present, 'blockTime')),
    kind:
      feeAtomic > 0n ? SETTLEMENT_KINDS.SETTLEMENT : SETTLEMENT_KINDS.REFUND,
    payer,
    ...sellerShare(deltas, payer),
    feeAtomic,
    residualAtomic: deltas.get(PROGRAM_TREASURY) ?? 0n,
    refundAtomic: payerDelta > 0n ? payerDelta : 0n,
    mint,
  };
}
