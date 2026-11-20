// Chain index rows for chain aggregate tests: the real devnet lifecycle in a chosen mint, and rows
// written straight into the node:sqlite D1 as the indexer writes them, so each formula is checked
// against known inputs.
import { readFileSync } from 'node:fs';

import { DEVNET_USDC } from '@gyblos/config/network';
import { decodeTransaction } from '@gyblos/metrics-collector/chain/decode';

import { withSignature } from './metrics-collector-chain';
import type { SqliteD1 } from './metrics-collector-d1';

export const LAB_MINT = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
export const OTHER_MINT = 'So11111111111111111111111111111111111111112';
export const DAY_MS = 86_400_000;
export const DAY1 = Date.UTC(2026, 10, 10);
export const day = (at: number) => new Date(at).toISOString().slice(0, 10);

// The real devnet lifecycle (open, settle_and_seal + distribute, reclaim), in a chosen mint.
export function lifecycle(mint: string) {
  return ['reclaim', 'seal-distribute', 'open'].map((name) => {
    const text = readFileSync(
      new URL(`../fixtures/chain/devnet-${name}.json`, import.meta.url),
      'utf8',
    ).replaceAll(LAB_MINT, mint);
    const tx = JSON.parse(text) as unknown;
    return withSignature(decodeTransaction(tx).signature, tx);
  });
}

export function chainRows(database: SqliteD1, scope: string) {
  return database
    .rows(
      `SELECT * FROM collector_agg_chain_daily WHERE scope = '${scope}' ORDER BY day`,
    )
    .map((row) => ({ ...row }));
}

// Direct chain index rows, as the indexer writes them.
export function tx(
  database: SqliteD1,
  signature: string,
  blockTime: number,
  indexedAt: number,
  extra: { failed?: number; undecodable?: number; slot?: number } = {},
) {
  database.raw
    .prepare(
      'INSERT INTO collector_chain_txs (signature, slot, block_time, failed, undecodable, memo, indexed_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    )
    .run(
      signature,
      extra.slot ?? Math.floor(blockTime / 400),
      blockTime,
      extra.failed ?? 0,
      extra.undecodable ?? 0,
      indexedAt,
    );
}
export function instruction(
  database: SqliteD1,
  signature: string,
  index: number,
  kind: string,
  channel: string,
  amounts: { amount?: string; cumulative?: string } = {},
) {
  database.raw
    .prepare(
      'INSERT INTO collector_chain_instructions (signature, instruction_index, kind, channel, payer, payee, mint, amount_atomic, cumulative_atomic, recipients_json) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)',
    )
    .run(
      signature,
      index,
      kind,
      channel,
      amounts.amount ?? null,
      amounts.cumulative ?? null,
    );
}
export function channel(
  database: SqliteD1,
  address: string,
  terms: { payer?: string; payee?: string; mint?: string; gyblos?: number },
) {
  database.raw
    .prepare(
      `INSERT INTO collector_chain_channels (channel, payer, payee, mint, gyblos, last_signature, last_slot, updated_at)
       VALUES (?, ?, ?, ?, ?, '', 0, 0)
       ON CONFLICT (channel) DO UPDATE SET payer = excluded.payer, payee = excluded.payee, mint = excluded.mint, gyblos = excluded.gyblos`,
    )
    .run(
      address,
      terms.payer ?? null,
      terms.payee ?? null,
      terms.mint ?? null,
      terms.gyblos ?? 1,
    );
}
export function delta(
  database: SqliteD1,
  signature: string,
  owner: string,
  amount: string,
  mint = DEVNET_USDC,
) {
  database.raw
    .prepare(
      'INSERT INTO collector_chain_token_deltas (signature, owner, mint, delta_atomic) VALUES (?, ?, ?, ?)',
    )
    .run(signature, owner, mint, amount);
}

// An open with a deposit and no block time: it caps what the channel's vouchers can settle without
// adding to any day.
export function fund(database: SqliteD1, address: string, amount = '1000000') {
  database.raw
    .prepare(
      'INSERT INTO collector_chain_txs (signature, slot, block_time, failed, undecodable, memo, indexed_at) VALUES (?, 0, NULL, 0, 0, NULL, 1)',
    )
    .run(`fund-${address}`);
  instruction(database, `fund-${address}`, 0, 'open', address, { amount });
}
