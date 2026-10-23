// Chain reads for payment accounting: RPC with 429 backoff for reads, inference confirmation, token
// addresses, balance snapshots and parsed SPL transfers. Read-only; never sends transactions.
import assert from 'node:assert/strict';

import { findAssociatedTokenPda } from '@solana-program/token';
import { address } from '@solana/kit';

import {
  COMMITMENT,
  HTTP_STATUS,
  RETRIES,
  RETRY_DELAYS,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

import { rpc as baseRpc, confirm } from '../chain.js';
import type {
  AccountsResponse,
  ChainInstruction,
  ChainTransaction,
} from './types.js';

// Only the chain-read fields accounting needs; callers pass their own configuration.
interface ChainReadConfig {
  rpcUrl: string;
  mint: string;
  addresses: { buyer: string; seller: string };
}

interface Transfer {
  source: string;
  destination: string;
  mint: string;
  amount: string;
}

async function readWithBackoff<T>(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await baseRpc<T>(rpcUrl, method, params);
    } catch (error) {
      if (
        attempt >= RETRIES.rpc ||
        !method.startsWith('get') ||
        !(error instanceof ProtocolError) ||
        error.code !== PROTOCOL_ERROR_CODES.RPC_HTTP ||
        !error.message.includes(String(HTTP_STATUS.tooManyRequests))
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS.rpcBase * 2 ** attempt),
      );
    }
  }
}

export function readChain<T>(
  config: Pick<ChainReadConfig, 'rpcUrl'>,
  method: string,
  params: unknown[],
): Promise<T> {
  return readWithBackoff<T>(config.rpcUrl, method, params);
}

export async function confirmInference(
  config: Pick<ChainReadConfig, 'rpcUrl'>,
  signature: string,
) {
  return confirm(config.rpcUrl, signature, {
    read: readWithBackoff,
    failedMessage: 'Inference transaction failed.',
    unknownMessage:
      'Inference confirmation is unknown; reconcile before another authorization.',
  });
}

export async function tokenAddress(owner: string, mint: string) {
  return (
    await findAssociatedTokenPda({
      owner: address(owner),
      mint: address(mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  )[0];
}

export async function inferenceSnapshot(
  config: ChainReadConfig,
  channelId?: string,
  minContextSlot?: number,
) {
  if (minContextSlot !== undefined)
    assert.ok(Number.isSafeInteger(minContextSlot) && minContextSlot >= 0);
  const owners = [
    config.addresses.buyer,
    config.addresses.seller,
    ...(channelId ? [channelId] : []),
  ];
  const atas = await Promise.all(
    owners.map((owner) => tokenAddress(owner, config.mint)),
  );
  const response = await readChain<AccountsResponse>(
    config,
    'getMultipleAccounts',
    [
      [...atas, config.addresses.buyer],
      {
        encoding: 'jsonParsed',
        commitment: COMMITMENT,
        ...(minContextSlot !== undefined ? { minContextSlot } : {}),
      },
    ],
  );
  if (minContextSlot !== undefined)
    assert.ok(
      Number.isSafeInteger(response.context.slot) &&
        response.context.slot >= minContextSlot,
      'Account snapshot predates the confirmed claim slot.',
    );
  const amounts = atas.map((_, index) => {
    const raw = response.value[index];
    if (!raw && index === 2) return '0';
    assert.equal(raw?.owner, TOKEN_PROGRAM_ADDRESS);
    const info = raw!.data.parsed.info;
    assert.equal(info.mint, config.mint);
    assert.equal(info.owner, owners[index]);
    return String(info.tokenAmount.amount);
  });
  return {
    slot: response.context.slot,
    buyer: amounts[0]!,
    seller: amounts[1]!,
    escrow: amounts[2] ?? null,
    buyerLamports: String(response.value[atas.length]?.lamports ?? 0),
  };
}

export async function transaction(
  config: Pick<ChainReadConfig, 'rpcUrl'>,
  signature: string,
) {
  for (let attempt = 0; attempt < RETRIES.transaction; attempt++) {
    const transaction = await readChain<ChainTransaction | null>(
      config,
      'getTransaction',
      [
        signature,
        {
          encoding: 'jsonParsed',
          commitment: COMMITMENT,
          maxSupportedTransactionVersion: 0,
        },
      ],
    );
    if (transaction === null) {
      if (attempt < RETRIES.transaction - 1)
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS.transactionVisibility),
        );
      continue;
    }
    assert.ok(transaction && transaction.meta.err === null);
    assert.equal(transaction.transaction.signatures[0], signature);
    return transaction;
  }
  throw new ProtocolError(
    PROTOCOL_ERROR_CODES.TRANSACTION_UNKNOWN,
    'Confirmed transaction is not yet visible; reconcile before another authorization.',
  );
}

export function transactionTransfers(
  transaction: ChainTransaction,
): Transfer[] {
  const found: Transfer[] = [];
  function visit(instruction: ChainInstruction) {
    if (instruction.programId !== TOKEN_PROGRAM_ADDRESS) return;
    const parsed = instruction.parsed;
    if (parsed?.type === 'batch') {
      for (const child of parsed.info.instructions)
        visit({ programId: TOKEN_PROGRAM_ADDRESS, parsed: child });
    } else if (parsed?.type === 'transferChecked') {
      const info = parsed.info;
      found.push({
        source: info.source,
        destination: info.destination,
        mint: info.mint,
        amount: info.tokenAmount.amount,
      });
    } else if (
      ![
        'initializeAccount',
        'initializeAccount2',
        'initializeAccount3',
        'initializeImmutableOwner',
        'getAccountDataSize',
        'closeAccount',
      ].includes(parsed?.type ?? '')
    ) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.UNSUPPORTED_TOKEN_INSTRUCTION,
        'Unsupported token instruction in inference accounting.',
      );
    }
  }
  for (const item of transaction.transaction.message.instructions) visit(item);
  for (const group of transaction.meta.innerInstructions ?? [])
    for (const item of group.instructions) visit(item);
  return found;
}
