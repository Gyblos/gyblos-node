// Chain index test fixtures: the real devnet lifecycle, Gyblos opens for distinct channels, plain
// traffic, live channel accounts and row readers over the node:sqlite D1.
import { readFileSync } from 'node:fs';

import { base58Encode } from '@gyblos/metrics-collector/chain/base58';
import { decodeTransaction } from '@gyblos/metrics-collector/chain/decode';

import {
  PROGRAM,
  withSignature,
  type ChainEntry,
} from './metrics-collector-chain';
import type { SqliteD1 } from './metrics-collector-d1';

export const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/chain/devnet-${name}.json`, import.meta.url),
      'utf8',
    ),
  );
export const OPEN = fixture('open');
export const SETTLE = fixture('seal-distribute');
export const RECLAIM = fixture('reclaim');
export const CHANNEL = 'EVQfRwtXxHj13yGVrbU8DnPLbvC1pNe2qxpMMZ3pR3jN';
export const signatureOf = (tx: unknown) => decodeTransaction(tx).signature;
export const real = (tx: unknown) => withSignature(signatureOf(tx), tx);
// The real lifecycle, newest first: an open with a Gyblos memo, a seal with distribute, a reclaim.
export const lifecycle = () => [real(RECLAIM), real(SETTLE), real(OPEN)];
export const rows = (database: SqliteD1, query: string) =>
  database.rows(query).map((row) => ({ ...row }));
export const counted = (database: SqliteD1) =>
  Number(
    rows(
      database,
      'SELECT coalesce(sum(transactions), 0) AS n FROM collector_chain_program_daily',
    )[0]!.n,
  );
export const readCount = (database: SqliteD1) =>
  rows(database, 'SELECT signature FROM collector_chain_txs').length;
export const plain = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) =>
    withSignature(`${prefix}${count - index}`),
  );
// A live channel account of the program (status byte 0: open).
export const openAccount = {
  owner: PROGRAM,
  data: Buffer.alloc(256).toString('base64'),
};
export const liveAccounts = (entries: ChainEntry[]) =>
  Object.fromEntries(
    entries.flatMap((entry) =>
      entry.addresses.slice(1).map((address) => [address, openAccount]),
    ),
  );
// Opens with a Gyblos memo for distinct channels.
export function gyblosOpens(count: number): ChainEntry[] {
  type Message = { instructions: { accounts?: string[] }[] };
  return Array.from({ length: count }, (_, index) => {
    const tx = structuredClone(OPEN) as { transaction: { message: Message } };
    const program = tx.transaction.message.instructions.find(
      (entry) => entry.accounts?.length === 14,
    )!;
    program.accounts![5] = base58Encode(
      Uint8Array.from({ length: 32 }, () => index + 1),
    );
    return withSignature(`open${index}`, tx);
  });
}
