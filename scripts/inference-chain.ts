import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { rpc, GateError } from '../packages/payments-x402/src/chain.js';
import type { Config } from './config.js';

export async function readChain<T>(
  c: Config,
  method: string,
  params: unknown[],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc<T>(c.rpcUrl, method, params);
    } catch (error) {
      if (
        attempt >= 4 ||
        !(error instanceof GateError) ||
        error.code !== 'RPC_HTTP' ||
        !error.message.includes('429')
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
    }
  }
}

export async function confirmInference(c: Config, signature: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await readChain<{
      value: (null | { err: unknown; confirmationStatus: string })[];
    }>(c, 'getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const status = result.value[0];
    if (status?.err)
      throw new GateError(
        'TRANSACTION_FAILED',
        'Inference transaction failed.',
      );
    if (
      status &&
      ['confirmed', 'finalized'].includes(status.confirmationStatus)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new GateError(
    'TRANSACTION_UNKNOWN',
    'Inference confirmation is unknown; reconcile before another authorization.',
  );
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
export async function inferenceSnapshot(c: Config, channelId?: string) {
  const owners = [
    c.addresses.buyer,
    c.addresses.seller,
    ...(channelId ? [channelId] : []),
  ];
  const atas = await Promise.all(
    owners.map((owner) => tokenAddress(owner, c.mint)),
  );
  const response = await readChain<{ context: { slot: number }; value: any[] }>(
    c,
    'getMultipleAccounts',
    [
      [...atas, c.addresses.buyer],
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ],
  );
  const amounts = atas.map((_, index) => {
    const raw = response.value[index];
    if (!raw && index === 2) return '0';
    assert.equal(raw?.owner, TOKEN_PROGRAM_ADDRESS);
    const info = raw.data.parsed.info;
    assert.equal(info.mint, c.mint);
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
export async function transaction(c: Config, signature: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await readChain<any>(c, 'getTransaction', [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (tx === null) {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    assert.ok(tx && tx.meta.err === null);
    assert.equal(tx.transaction.signatures[0], signature);
    return tx;
  }
  throw new GateError(
    'TRANSACTION_UNKNOWN',
    'Confirmed transaction is not yet visible; reconcile before another authorization.',
  );
}
interface Transfer {
  source: string;
  destination: string;
  mint: string;
  amount: string;
}
export function transactionTransfers(tx: any): Transfer[] {
  const found: Transfer[] = [];
  function visit(instruction: any) {
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
      ].includes(parsed?.type)
    ) {
      throw new GateError(
        'UNSUPPORTED_TOKEN_INSTRUCTION',
        'Unsupported token instruction in inference accounting.',
      );
    }
  }
  for (const item of tx.transaction.message.instructions) visit(item);
  for (const group of tx.meta.innerInstructions ?? [])
    for (const item of group.instructions) visit(item);
  return found;
}
