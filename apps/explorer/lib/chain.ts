// Owns the read-only Solana reads for Gyblos settlements on the shared payment-channels program.
// Gyblos traffic is identified by the fee paid to the Gyblos treasury, so settlements with a zero fee
// are not visible here; the chain indexer (gyblos-node #349) replaces this.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cacheLife } from 'next/cache';

import {
  CHANNEL_PROGRAM,
  GYBLOS_TREASURY,
  PROGRAM_TREASURY,
  SOLANA_RPC_URL,
  TOKEN_PROGRAM,
} from './config';
import { CACHE_LIFE, SOLANA_RPC } from './constants';

export interface Settlement {
  signature: string;
  slot: number;
  blockTime: number | null;
  kind: 'settlement' | 'refund';
  payer: string | null;
  seller: string | null;
  // Atomic units (6 decimals for the devnet test USDC mints).
  sellerAtomic: bigint;
  feeAtomic: bigint;
  residualAtomic: bigint;
  refundAtomic: bigint;
  mint: string | null;
}

export interface ChainSnapshot {
  fetchedAt: number;
  settlements: Settlement[];
  // Transactions listed but not read yet (still filling under the RPC rate limit).
  pending: number;
  error: string | null;
}

let rpcId = 0;
// A dedicated provider (SOLANA_RPC_URL) needs no spacing.
const SPACING_MS = process.env.SOLANA_RPC_URL ? 0 : SOLANA_RPC.publicSpacingMs;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (SPACING_MS) await sleep(SPACING_MS);
  for (let attempt = 0; attempt < SOLANA_RPC.maxAttempts; attempt += 1) {
    const response = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: SOLANA_RPC.jsonRpc,
        id: ++rpcId,
        method,
        params,
      }),
    });
    if (response.status === SOLANA_RPC.tooManyRequests) {
      await sleep(
        SOLANA_RPC.backoffBaseMs *
          2 ** Math.min(attempt, SOLANA_RPC.maxBackoffExponent),
      );
      continue;
    }
    if (!response.ok) throw new Error(`rpc ${method}: HTTP ${response.status}`);
    const body = (await response.json()) as {
      result?: T;
      error?: { message: string };
    };
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
    return body.result as T;
  }
  throw new Error(`rpc ${method}: rate limited`);
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}
interface ParsedTx {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    signatures: string[];
    message: {
      instructions: { programId: string; accounts?: string[] }[];
    };
  };
}

// Net token change per owner across the transaction, and the first mint seen.
function balanceDeltas(meta: NonNullable<ParsedTx['meta']>) {
  const deltas = new Map<string, bigint>();
  let mint: string | null = null;
  for (const balance of meta.preTokenBalances ?? []) {
    if (!balance.owner) continue;
    deltas.set(
      balance.owner,
      (deltas.get(balance.owner) ?? 0n) - BigInt(balance.uiTokenAmount.amount),
    );
  }
  for (const balance of meta.postTokenBalances ?? []) {
    if (!balance.owner) continue;
    mint ??= balance.mint;
    deltas.set(
      balance.owner,
      (deltas.get(balance.owner) ?? 0n) + BigInt(balance.uiTokenAmount.amount),
    );
  }
  return { deltas, mint };
}

function classify(tx: ParsedTx): Settlement | null {
  const signature = tx.transaction.signatures[0];
  if (!tx.meta || tx.meta.err || !signature) return null;
  const channelInstruction = tx.transaction.message.instructions.find(
    (instruction) =>
      instruction.programId === CHANNEL_PROGRAM &&
      (instruction.accounts?.length ?? 0) > SOLANA_RPC.minChannelAccounts,
  );
  if (!channelInstruction) return null;
  const payer =
    channelInstruction.accounts?.[SOLANA_RPC.payerAccountIndex] ?? null;
  const { deltas, mint } = balanceDeltas(tx.meta);

  const feeAtomic = deltas.get(GYBLOS_TREASURY) ?? 0n;
  const residualAtomic = deltas.get(PROGRAM_TREASURY) ?? 0n;
  const payerDelta = payer ? (deltas.get(payer) ?? 0n) : 0n;
  const refundAtomic = payerDelta > 0n ? payerDelta : 0n;

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

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    kind: feeAtomic > 0n ? 'settlement' : 'refund',
    payer,
    seller,
    sellerAtomic,
    feeAtomic,
    residualAtomic,
    refundAtomic,
    mint,
  };
}

async function treasurySignatures(): Promise<string[]> {
  const accounts = await rpc<{ value: { pubkey: string }[] }>(
    'getTokenAccountsByOwner',
    [GYBLOS_TREASURY, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }],
  );
  const seen = new Set<string>();
  for (const { pubkey } of accounts.value) {
    let before: string | undefined;
    for (let page = 0; page < SOLANA_RPC.maxSignaturePages; page += 1) {
      const listed = await rpc<{ signature: string; err: unknown }[]>(
        'getSignaturesForAddress',
        [
          pubkey,
          {
            limit: SOLANA_RPC.signaturesPerPage,
            ...(before ? { before } : {}),
          },
        ],
      );
      for (const entry of listed) if (!entry.err) seen.add(entry.signature);
      const last = listed.at(-1);
      if (listed.length < SOLANA_RPC.signaturesPerPage || !last) break;
      before = last.signature;
    }
  }
  return [...seen];
}

// Finalized transactions never change, so each classified transaction is stored on disk once and
// reused; only the signature list is refreshed. The public devnet RPC allows only a few
// getTransaction calls per window, so a cold start fills slowly and later loads are instant.
type Stored = Omit<
  Settlement,
  'sellerAtomic' | 'feeAtomic' | 'residualAtomic' | 'refundAtomic'
> & {
  sellerAtomic: string;
  feeAtomic: string;
  residualAtomic: string;
  refundAtomic: string;
};

const STORE_DIR = path.join(process.cwd(), '.cache', 'settlements');
const memory = new Map<string, Stored | null>();

async function readStored(
  signature: string,
): Promise<Stored | null | undefined> {
  if (memory.has(signature)) return memory.get(signature);
  try {
    const value = JSON.parse(
      await readFile(path.join(STORE_DIR, `${signature}.json`), 'utf8'),
    ) as { row: Stored | null };
    memory.set(signature, value.row);
    return value.row;
  } catch {
    return undefined;
  }
}

async function writeStored(signature: string, row: Stored | null) {
  memory.set(signature, row);
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(
    path.join(STORE_DIR, `${signature}.json`),
    JSON.stringify({ row }),
  );
}

function toStored(settlement: Settlement): Stored {
  return {
    ...settlement,
    sellerAtomic: settlement.sellerAtomic.toString(),
    feeAtomic: settlement.feeAtomic.toString(),
    residualAtomic: settlement.residualAtomic.toString(),
    refundAtomic: settlement.refundAtomic.toString(),
  };
}

function fromStored(row: Stored): Settlement {
  return {
    ...row,
    sellerAtomic: BigInt(row.sellerAtomic),
    feeAtomic: BigInt(row.feeAtomic),
    residualAtomic: BigInt(row.residualAtomic),
    refundAtomic: BigInt(row.refundAtomic),
  };
}

// Cheap and cached: a few calls list the treasury's transaction signatures.
async function listSignatures(): Promise<{
  listedAt: number;
  signatures: string[];
}> {
  'use cache';
  cacheLife(CACHE_LIFE.signatures);
  return { listedAt: Date.now(), signatures: await treasurySignatures() };
}

let filling: Promise<void> | null = null;
// Fetches missing transactions one at a time in the background, respecting the rate limit.
function fillMissing(signatures: string[]) {
  filling ??= (async () => {
    for (const signature of signatures) {
      if ((await readStored(signature)) !== undefined) continue;
      try {
        const tx = await rpc<ParsedTx | null>('getTransaction', [
          signature,
          {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          },
        ]);
        const settlement = tx ? classify(tx) : null;
        await writeStored(signature, settlement ? toStored(settlement) : null);
        await sleep(SOLANA_RPC.fillSpacingMs);
      } catch {
        break;
      }
    }
  })().finally(() => {
    filling = null;
  });
  return filling;
}

async function storedSettlements(signatures: string[]) {
  const rows: Settlement[] = [];
  let pending = 0;
  for (const signature of signatures) {
    const stored = await readStored(signature);
    if (stored === undefined) pending += 1;
    else if (stored) rows.push(fromStored(stored));
  }
  return { rows, pending };
}

export async function getChain(): Promise<ChainSnapshot> {
  let listed: { listedAt: number; signatures: string[] };
  try {
    listed = await listSignatures();
  } catch (error) {
    return {
      fetchedAt: 0,
      settlements: [],
      pending: 0,
      error: error instanceof Error ? error.message : 'chain unavailable',
    };
  }
  let stored = await storedSettlements(listed.signatures);
  if (stored.pending) {
    // Wait briefly so a small backlog completes in this request; the rest continues in background.
    await Promise.race([
      fillMissing(listed.signatures),
      sleep(SOLANA_RPC.fillWaitMs),
    ]);
    stored = await storedSettlements(listed.signatures);
  }
  stored.rows.sort(
    (left, right) => (right.blockTime ?? 0) - (left.blockTime ?? 0),
  );
  return {
    fetchedAt: listed.listedAt,
    settlements: stored.rows,
    pending: stored.pending,
    error: null,
  };
}
