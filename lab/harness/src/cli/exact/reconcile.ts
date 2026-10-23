// Devnet USDC balance snapshots (retried on 429), authorization metadata from a signed payload, and
// a read-only scan of buyer history for the payment signature.
import assert from 'node:assert/strict';

import { findAssociatedTokenPda } from '@solana-program/token';
import {
  address,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import type { PaymentPayload } from '@x402/core/types';

import {
  COMMITMENT,
  DEVNET_USDC,
  HTTP_STATUS,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config';
import {
  type AccountsResponse,
  type ChainTransaction,
} from '@gyblos/payments-x402/accounting/types';
import { lamports, rpc } from '@gyblos/payments-x402/chain';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

import {
  GATE_DIAGNOSTIC_LIMITS,
  GATE_FUNDING_LIMITS,
  GATE_RETRIES,
  GATE_RETRY_DELAYS,
  RECONCILIATION_CLASSIFICATIONS,
} from '../../constants.js';
import { exactAuthorizationId } from '../../exact/authorization-id.js';
import { type Config } from '../../wallet.js';

export async function snapshot(config: Config, buyer: string) {
  const atas = await Promise.all(
    [buyer, config.addresses.seller].map((owner) =>
      findAssociatedTokenPda({
        owner: address(owner),
        mint: address(DEVNET_USDC),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ),
  );
  let result: AccountsResponse | undefined;
  for (let attempt = 0; attempt < GATE_RETRIES.exactSnapshot; attempt++) {
    try {
      result = await rpc<AccountsResponse>(
        config.rpcUrl,
        'getMultipleAccounts',
        [
          [atas[0]![0], atas[1]![0], buyer],
          { encoding: 'jsonParsed', commitment: COMMITMENT },
        ],
      );
      break;
    } catch (error) {
      if (
        !(error instanceof ProtocolError) ||
        error.code !== PROTOCOL_ERROR_CODES.RPC_HTTP ||
        !error.message.includes(String(HTTP_STATUS.tooManyRequests)) ||
        attempt === GATE_RETRIES.exactSnapshotLastAttempt
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, GATE_RETRY_DELAYS.exactSnapshotBase * 2 ** attempt),
      );
    }
  }
  assert.ok(result);
  const amounts = result.value.slice(0, 2).map((account, index) => {
    const info = account?.data?.parsed?.info;
    assert.equal(account?.owner, TOKEN_PROGRAM_ADDRESS);
    assert.equal(info?.mint, DEVNET_USDC);
    assert.equal(info?.owner, index === 0 ? buyer : config.addresses.seller);
    assert.equal(
      info?.tokenAmount?.decimals,
      GATE_FUNDING_LIMITS.tokenDecimals,
    );
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
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(wire as string),
  );
  const signature =
    transaction.signatures[buyer as keyof typeof transaction.signatures];
  assert.ok(signature);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  return {
    authorizationHash: exactAuthorizationId(wire as string),
    buyerSignature: getBase58Decoder().decode(signature),
    blockhash: compiled.lifetimeToken,
  };
}

// Public metadata only. An absent match is an observation, not proof of failure/refund.
export async function reconcile(
  config: Config,
  buyer: string,
  buyerSignature: string,
) {
  const history = await rpc<{ signature: string }[]>(
    config.rpcUrl,
    'getSignaturesForAddress',
    [
      buyer,
      {
        limit: GATE_DIAGNOSTIC_LIMITS.transactionHistory,
        commitment: COMMITMENT,
      },
    ],
  );
  const matches = [];
  for (const item of history) {
    const transaction = await rpc<ChainTransaction | null>(
      config.rpcUrl,
      'getTransaction',
      [
        item.signature,
        {
          encoding: 'jsonParsed',
          commitment: COMMITMENT,
          maxSupportedTransactionVersion: 0,
        },
      ],
    );
    if (transaction?.transaction.signatures.includes(buyerSignature))
      matches.push({
        signature: item.signature,
        slot: transaction.slot,
        error: transaction.meta?.err,
      });
  }
  return {
    checkedAt: new Date().toISOString(),
    address: buyer,
    historyLimit: GATE_DIAGNOSTIC_LIMITS.transactionHistory,
    matches,
    classification: matches.length
      ? RECONCILIATION_CLASSIFICATIONS.MATCHED
      : RECONCILIATION_CLASSIFICATIONS.NOT_OBSERVED,
  };
}
