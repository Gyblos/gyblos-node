// Builds the buyer's payment client on the real chain: the durable journal (one buyer process at a
// time), blockhash hints proven to come from the policy's network, and settlement checks read from the
// claim transaction. The payer key is the caller's; nothing here reads key files.
import { createSolanaRpc, type TransactionSigner } from '@solana/kit';
import {
  createUptoHintReader,
  type UptoHintRpc,
  type UptoTransactionRpc,
} from 'x402-upto-metered';

import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError, type PaymentClient } from '@gyblos/protocol/payment';

import { openUptoBuyerJournal } from './buyer-journal';
import {
  createUptoPaymentClient,
  uptoSettlementView,
  type UptoBuyerPolicy,
} from './client';
import type { UptoLedgerPaths } from './file-ledger';
import { assertPaymentNetworkEnabled } from './mainnet';
import type { UptoChannelSettings } from './terms';

export interface UptoBuyerPaymentsOptions {
  rpcUrl: string;
  policy: UptoBuyerPolicy;
  settings: UptoChannelSettings;
  payer: TransactionSigner;
  paths: UptoLedgerPaths;
  now?: () => number;
  // Tests inject a double; production reads the chain at rpcUrl.
  rpc?: UptoHintRpc & UptoTransactionRpc;
}

export interface UptoBuyerPayments {
  client: PaymentClient;
  close(): Promise<void>;
}

// A CAIP-2 network id; anything else is a policy the buyer could never honor.
const caip = (network: string): network is `${string}:${string}` =>
  network.includes(':');

export async function openUptoBuyerPayments(
  options: UptoBuyerPaymentsOptions,
): Promise<UptoBuyerPayments> {
  assertPaymentNetworkEnabled(options.policy.network);
  const now = options.now ?? Date.now;
  const network = options.policy.network;
  if (!caip(network))
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  const journal = await openUptoBuyerJournal({ paths: options.paths, now });
  const rpc = options.rpc ?? createSolanaRpc(options.rpcUrl);
  const hints = createUptoHintReader(rpc, network);
  try {
    const client = createUptoPaymentClient({
      payer: options.payer,
      policy: options.policy,
      settings: options.settings,
      hints: () => hints.hints(),
      journal,
      confirm: uptoSettlementView(rpc, options.policy, options.payer),
      now,
    });
    return { client, close: () => journal.close() };
  } catch (error) {
    await journal.close();
    throw error;
  }
}
