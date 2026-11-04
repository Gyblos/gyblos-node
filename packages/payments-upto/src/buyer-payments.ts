// Builds the buyer's payment client on the real chain: the durable journal (one buyer process at a
// time), blockhash hints proven to come from the policy's network, and settlement checks read from the
// claim transaction. The payer key is the caller's; nothing here reads key files.
import { createSolanaRpc, type TransactionSigner } from '@solana/kit';
import {
  createUptoHintReader,
  type UptoHintRpc,
  type UptoTransactionRpc,
} from 'x402-upto-metered';

import { TIMEOUTS } from '@gyblos/config';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError, type PaymentClient } from '@gyblos/protocol/payment';

import { openUptoBuyerJournal } from './buyer-journal';
import { observationSdk } from './buyer-observation-sdk';
import { createBuyerObservationRpc } from './buyer-observation-transport';
import {
  observeUptoBuyer,
  type UptoChargeObservation,
  type UptoReconcileOptions,
} from './buyer-reconcile';
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
  // Synthetic tests can inject an independent read-only history port.
  observationRpc?: UptoReconcileOptions['rpc'];
}

export interface UptoBuyerPayments {
  client: PaymentClient;
  observe?(
    requestDigest: string,
    signal?: AbortSignal,
  ): Promise<UptoChargeObservation | undefined>;
  close(): Promise<void>;
}

// A CAIP-2 network id; anything else is a policy the buyer could never honor.
const caip = (network: string): network is `${string}:${string}` =>
  network.includes(':');

export async function openUptoBuyerPayments(
  options: UptoBuyerPaymentsOptions,
): Promise<UptoBuyerPayments> {
  const policy = { ...options.policy };
  const settings = { ...options.settings };
  const payerAddress = options.payer.address;
  const injectedObservationRpc = options.observationRpc;
  const rpcUrl = options.rpcUrl;
  assertPaymentNetworkEnabled(policy.network);
  const now = options.now ?? Date.now;
  const network = policy.network;
  if (!caip(network))
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  const journal = await openUptoBuyerJournal({ paths: options.paths, now });
  const useConfiguredRpc = options.rpc === undefined;
  const rpc = options.rpc ?? createSolanaRpc(rpcUrl);
  const hints = createUptoHintReader(rpc, network);
  try {
    const client = createUptoPaymentClient({
      payer: options.payer,
      policy,
      settings,
      hints: () => hints.hints(),
      journal,
      confirm: uptoSettlementView(rpc, policy, options.payer),
      now,
    });
    return {
      client,
      observe: async (requestDigest, outerSignal) => {
        const signal = AbortSignal.any([
          AbortSignal.timeout(TIMEOUTS.rpc),
          ...(outerSignal ? [outerSignal] : []),
        ]);
        const history =
          injectedObservationRpc ??
          (useConfiguredRpc
            ? observationSdk(createBuyerObservationRpc(rpcUrl), signal)
            : undefined);
        if (!history) return undefined;
        return observeUptoBuyer({
          journal,
          rpc: history,
          network: policy.network,
          payer: payerAddress,
          mint: policy.mint,
          treasury: policy.treasury,
          requestDigest,
          signal,
        });
      },
      close: () => journal.close(),
    };
  } catch (error) {
    await journal.close();
    throw error;
  }
}
