// Builds the seller's payment server on the real chain: the durable ledger, the SDK facilitator signing
// with the fee payer, offline verification, vouchers by the authorizer, channel reads over RPC, the
// token accounts every claim pays into, recovery of earlier claims and the SDK's rent cleanup. Keys
// are the caller's; nothing here reads key files.
import { createSolanaRpc, type KeyPairSigner } from '@solana/kit';
import { toFacilitatorSvmSigner } from '@x402/svm';
import {
  createUptoChannelReaders,
  createUptoFacilitator,
  createUptoRecipientAccounts,
  createUptoSdkChain,
  createUptoSeller,
  createUptoVerifier,
  UPTO_COMMITMENT,
  UPTO_SOLANA_NAMESPACE,
  UPTO_SOLANA_REFERENCE_LENGTH,
  uptoChannelRpc,
  UptoError,
  type UptoKitRpc,
  type UptoRecipientAccountsRpc,
} from 'x402-upto-metered';

import { TIMEOUTS } from '@gyblos/config';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentDescription,
  type PaymentServer,
} from '@gyblos/protocol/payment';

import { LEDGER_FILE, UPTO_SELLER } from './constants';
import { openUptoFileLedger, type UptoLedgerPaths } from './file-ledger';
import { assertPaymentNetworkEnabled } from './mainnet';
import { createUptoPaymentServer } from './server';
import { uptoSellerTerms, type UptoChannelSettings } from './terms';

export interface UptoSellerPaymentsOptions {
  rpcUrl: string;
  description: PaymentDescription;
  settings: UptoChannelSettings;
  // Signs and pays for every channel transaction, and fronts channel rent.
  feePayer: KeyPairSigner;
  // Signs the vouchers that let a claim charge an open channel.
  authorizer: KeyPairSigner;
  paths: UptoLedgerPaths;
  cleanup: { intervalSecs: number; abandonGraceSecs: number };
  now?: () => number;
  // Tests inject a double; production reads the chain at rpcUrl.
  rpc?: UptoKitRpc &
    UptoRecipientAccountsRpc & {
      getGenesisHash(): {
        send(config?: { abortSignal: AbortSignal }): Promise<string>;
      };
      getSlot(config: { commitment: typeof UPTO_COMMITMENT }): {
        send(): Promise<bigint>;
      };
    };
  sleep?: (ms: number) => Promise<void>;
}

export interface UptoSellerPayments {
  server: PaymentServer;
  // Re-drives the ledger's unfinished channels with their recorded charges.
  recover(): Promise<void>;
  close(): Promise<void>;
}

export async function openUptoSellerPayments(
  options: UptoSellerPaymentsOptions,
): Promise<UptoSellerPayments> {
  const description = { ...options.description };
  const settings = { ...options.settings };
  const { feePayer, authorizer } = options;
  assertPaymentNetworkEnabled(description.network);
  const now = options.now ?? Date.now;
  const own = uptoSellerTerms(description, settings);
  if (
    feePayer.address !== description.feePayer ||
    authorizer.address !== description.authorizer
  )
    // Keys that cannot sign for this description would only fail later, on a buyer's deposit.
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  const rpc = options.rpc ?? createSolanaRpc(options.rpcUrl);
  const [namespace, reference, ...rest] = own.network.split(':');
  let genesis: string;
  try {
    genesis = await rpc.getGenesisHash().send({
      abortSignal: AbortSignal.timeout(TIMEOUTS.rpc),
    });
  } catch {
    throw new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE);
  }
  if (
    namespace !== UPTO_SOLANA_NAMESPACE ||
    reference?.length !== UPTO_SOLANA_REFERENCE_LENGTH ||
    rest.length !== 0 ||
    String(genesis).slice(0, UPTO_SOLANA_REFERENCE_LENGTH) !== reference
  )
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  const ledger = await openUptoFileLedger({
    paths: options.paths,
    now,
    retentionMs: LEDGER_FILE.minRetentionMs,
    maxChannels: UPTO_SELLER.maxChannels,
  });
  try {
    // payTo, the fee treasury and the channel payee (the fee payer), which a claim may each pay.
    const recipients = createUptoRecipientAccounts(rpc, {
      feePayer,
      mint: description.mint,
      tokenProgram: settings.tokenProgram,
      owners: [description.payTo, description.treasury, feePayer.address],
      sleep: options.sleep,
    });
    // Before anything is admitted: a seller whose payouts would be redirected does not start.
    await recipients.ensure().catch((error: unknown) => {
      throw error instanceof UptoError
        ? new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE)
        : error;
    });
    const facilitator = createUptoFacilitator(
      toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: options.rpcUrl }),
      ledger.chain,
    );
    const readers = createUptoChannelReaders(uptoChannelRpc(rpc), {
      network: own.network,
      rentPayer: feePayer.address,
    });
    const seller = createUptoSeller({
      chain: createUptoSdkChain({
        facilitator,
        verify: createUptoVerifier(feePayer.address, () =>
          rpc.getSlot({ commitment: UPTO_COMMITMENT }).send(),
        ),
        authorizer,
        store: ledger.chain,
        channelExists: readers.channelExists,
        settledClaim: readers.settledClaim,
        now,
        openWindowMs: UPTO_SELLER.openWindowMs,
        recipients,
      }),
      store: ledger.channels,
      now,
      own,
    });
    const server = createUptoPaymentServer({ description, settings, seller });
    // Last, so no failure above leaves its timer signing with the fee payer.
    const cleanup = facilitator.createRentCleanupManager(own.network);
    cleanup.start(options.cleanup);
    return {
      server,
      async recover() {
        await seller.recover();
      },
      // Rent cleanup first: a pass in flight still submits through the facilitator.
      async close() {
        await cleanup.stop();
        await ledger.close();
      },
    };
  } catch (error) {
    await ledger.close();
    throw error;
  }
}
