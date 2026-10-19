import assert from 'node:assert/strict';

import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  address,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import type { PaymentPayload } from '@x402/core/types';

import { COMMITMENT } from '@gyblos/config';
import { type Config } from '@gyblos/gate/config';
import type { AccountsResponse, ChainTransaction } from '@gyblos/gate/types';
import { GateError, lamports, rpc } from '@gyblos/payments-x402/chain';
import { DEVNET_USDC } from '@gyblos/payments-x402/constants';
import { exactAuthorizationId } from '@gyblos/payments-x402/exact/authorization-id';

export async function snapshot(c: Config, buyer: string) {
  const atas = await Promise.all(
    [buyer, c.addresses.seller].map((owner) =>
      findAssociatedTokenPda({
        owner: address(owner),
        mint: address(DEVNET_USDC),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ),
  );
  let result: AccountsResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      result = await rpc<AccountsResponse>(c.rpcUrl, 'getMultipleAccounts', [
        [atas[0]![0], atas[1]![0], buyer],
        { encoding: 'jsonParsed', commitment: COMMITMENT },
      ]);
      break;
    } catch (error) {
      if (
        !(error instanceof GateError) ||
        error.code !== 'RPC_HTTP' ||
        !error.message.includes('429') ||
        attempt === 3
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  assert.ok(result);
  const amounts = result.value.slice(0, 2).map((account, index) => {
    const info = account?.data?.parsed?.info;
    assert.equal(account?.owner, TOKEN_PROGRAM_ADDRESS);
    assert.equal(info?.mint, DEVNET_USDC);
    assert.equal(info?.owner, index === 0 ? buyer : c.addresses.seller);
    assert.equal(info?.tokenAmount?.decimals, 6);
    return String(info!.tokenAmount.amount);
  });
  return {
    buyer: amounts[0]!,
    seller: amounts[1]!,
    buyerLamports: String(result.value[2]?.lamports ?? 0),
  };
}
export function authorizationMetadata(payload: PaymentPayload, buyer: string) {
  const wire = payload.payload.transaction;
  assert.equal(typeof wire, 'string');
  const tx = getTransactionDecoder().decode(
    getBase64Encoder().encode(wire as string),
  );
  const signature = tx.signatures[buyer as keyof typeof tx.signatures];
  assert.ok(signature);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  return {
    authorizationHash: exactAuthorizationId(wire as string),
    buyerSignature: getBase58Decoder().decode(signature),
    blockhash: compiled.lifetimeToken,
  };
}
// Public metadata only. An absent match is an observation, not proof of failure/refund.
export async function reconcile(
  c: Config,
  buyer: string,
  buyerSignature: string,
) {
  const history = await rpc<{ signature: string }[]>(
    c.rpcUrl,
    'getSignaturesForAddress',
    [buyer, { limit: 50, commitment: COMMITMENT }],
  );
  const matches = [];
  for (const item of history) {
    const tx = await rpc<ChainTransaction | null>(c.rpcUrl, 'getTransaction', [
      item.signature,
      {
        encoding: 'jsonParsed',
        commitment: COMMITMENT,
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (tx?.transaction.signatures.includes(buyerSignature))
      matches.push({
        signature: item.signature,
        slot: tx.slot,
        error: tx.meta?.err,
      });
  }
  return {
    checkedAt: new Date().toISOString(),
    address: buyer,
    historyLimit: 50,
    matches,
    classification: matches.length
      ? 'matching-transaction-observed'
      : 'no-matching-transaction-observed',
  };
}
