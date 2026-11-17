// Owns the read-only Solana reads for Gyblos settlements on the shared payment-channels program: the
// treasury's signature list (cached) and each finalized transaction (stored on disk once). Gyblos
// traffic is identified by the fee paid to the Gyblos treasury (settlement.ts), so settlements with a
// zero fee are not visible here; the chain indexer (gyblos-node #349) replaces this.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cacheLife } from 'next/cache';
import { connection } from 'next/server';

import { GYBLOS_TREASURY, SOLANA_RPC_URL, TOKEN_PROGRAM } from './config';
import { CACHE_LIFE, SOLANA_RPC } from './constants';
import { classify, type Settlement } from './settlement';
import { list, record, text } from './validate';

export type { Settlement } from './settlement';

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

async function rpc(method: string, params: unknown[]): Promise<unknown> {
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
    const body = record((await response.json()) as unknown, `rpc ${method}`);
    if (body.error)
      throw new Error(`rpc ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  throw new Error(`rpc ${method}: rate limited`);
}

async function treasurySignatures(): Promise<string[]> {
  const accounts = record(
    await rpc('getTokenAccountsByOwner', [
      GYBLOS_TREASURY,
      { programId: TOKEN_PROGRAM },
      { encoding: 'jsonParsed' },
    ]),
    'token accounts',
  );
  const seen = new Set<string>();
  for (const account of list(accounts.value, 'token accounts.value')) {
    const pubkey = text(record(account, 'account').pubkey, 'account.pubkey');
    let before: string | undefined;
    for (let page = 0; page < SOLANA_RPC.maxSignaturePages; page += 1) {
      const listed = list(
        await rpc('getSignaturesForAddress', [
          pubkey,
          {
            limit: SOLANA_RPC.signaturesPerPage,
            ...(before ? { before } : {}),
          },
        ]),
        'signatures',
      ).map((entry) => record(entry, 'signature entry'));
      for (const entry of listed)
        if (!entry.err) seen.add(text(entry.signature, 'signature'));
      const last = listed.at(-1);
      if (listed.length < SOLANA_RPC.signaturesPerPage || !last) break;
      before = text(last.signature, 'signature');
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
        const tx = await rpc('getTransaction', [
          signature,
          {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          },
        ]);
        const settlement = classify(tx);
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
    // A failed read is never prerendered: it is retried on the next request.
    await connection();
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
