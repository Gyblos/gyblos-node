// Creates a reusable-channel open using the SDK, without signing a voucher or broadcasting.
// The caller must verify the seller, provide recent chain hints and independently confirm the open.
import {
  isAddress,
  type MessagePartialSigner,
  type TransactionPartialSigner,
} from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@x402/svm';
import { UptoSvmScheme } from '@x402/svm/upto/client';

import {
  DEVNET,
  PROTOCOL_FEE,
  TOKEN_PROGRAM_ADDRESS,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import { UPTO_BUYER_DISTINCT_PARTIES } from './constants';
import {
  assertMainnetPilotDeposit,
  assertPaymentNetworkEnabled,
} from './mainnet';
import type { ReusableJournal } from './reusable-journal';
import {
  atomic,
  parseTerms,
  unavailable,
  type ReusableChannelTerms,
} from './reusable-journal-model';
import { reusableOpeningMemo } from './reusable-opening-memo';

export interface ReusableOpeningOptions extends Omit<
  ReusableChannelTerms,
  'channelId' | 'salt' | 'buyer' | 'recentBlockhash'
> {
  journal: Pick<ReusableJournal, 'beginOpening' | 'completeOpening'>;
  signer: TransactionPartialSigner & MessagePartialSigner;
  recentBlockhash: string;
  // This policy must come from the buyer's trusted local configuration, not a seller.
  policy: {
    network: string;
    mint: string;
    treasury: string;
    protocolFeeBps: number;
    maxDepositAtomic: string;
  };
}
export interface ReusableOpeningPayload {
  channelId: string;
  openTransaction: string;
  authorizedSigner: string;
  deposit: string;
  maxAmount: string;
  nonce: string;
  openSlot: string;
  from: string;
  expiresAt: number;
  validAfter: number;
}
function payload(value: unknown): ReusableOpeningPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    !(
      'channelId' in value &&
      'openTransaction' in value &&
      'authorizedSigner' in value &&
      'deposit' in value &&
      'maxAmount' in value &&
      'nonce' in value &&
      'openSlot' in value &&
      'from' in value &&
      'expiresAt' in value &&
      'validAfter' in value
    ) ||
    typeof value.channelId !== 'string' ||
    typeof value.openTransaction !== 'string' ||
    typeof value.authorizedSigner !== 'string' ||
    typeof value.deposit !== 'string' ||
    typeof value.maxAmount !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof value.openSlot !== 'string' ||
    typeof value.from !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    typeof value.validAfter !== 'number'
  )
    return unavailable();
  return {
    channelId: value.channelId,
    openTransaction: value.openTransaction,
    authorizedSigner: value.authorizedSigner,
    deposit: value.deposit,
    maxAmount: value.maxAmount,
    nonce: value.nonce,
    openSlot: value.openSlot,
    from: value.from,
    expiresAt: value.expiresAt,
    validAfter: value.validAfter,
  };
}

export { reusableOpeningMemo } from './reusable-opening-memo';

function guardOpeningSigner(
  journal: ReusableOpeningOptions['journal'],
  terms: ReusableChannelTerms,
  signer: ReusableOpeningOptions['signer'],
) {
  let bound: ReusableChannelTerms | undefined;
  const guardedSigner = {
    address: signer.address,
    signMessages: signer.signMessages.bind(signer),
    async signTransactions(
      ...args: Parameters<typeof signer.signTransactions>
    ) {
      const transactions = args[0];
      if (bound || transactions.length !== 1 || !transactions[0])
        return unavailable();
      bound = await journal.completeOpening(
        terms.buyer,
        Uint8Array.from(transactions[0].messageBytes),
        signer,
      );
      return signer.signTransactions(...args);
    },
  };
  return { signer: guardedSigner, bound: () => bound };
}

export async function createReusableOpening(
  options: ReusableOpeningOptions,
): Promise<{ payload: ReusableOpeningPayload }> {
  const { journal, signer, recentBlockhash, policy, ...requested } = options;
  const terms = parseTerms({
    ...requested,
    buyer: signer.address,
    channelId: signer.address,
    salt: '0',
    recentBlockhash,
  });
  assertMainnetPilotDeposit({
    network: terms.network,
    mint: terms.mint,
    maxAtomic: terms.depositAtomic,
  });
  assertPaymentNetworkEnabled(terms.network);
  if (
    terms.network !== policy.network ||
    terms.mint !== policy.mint ||
    terms.treasury !== policy.treasury ||
    terms.protocolFeeBps !== policy.protocolFeeBps ||
    BigInt(terms.depositAtomic) > BigInt(atomic(policy.maxDepositAtomic))
  )
    unavailable();
  if (
    !isAddress(recentBlockhash) ||
    terms.network !== DEVNET ||
    (terms.tokenProgram !== TOKEN_PROGRAM_ADDRESS &&
      terms.tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) ||
    terms.protocolFeeBps !== PROTOCOL_FEE.bps ||
    new Set([terms.buyer, terms.payTo, terms.feePayer, terms.treasury]).size !==
      UPTO_BUYER_DISTINCT_PARTIES
  )
    unavailable();
  const [namespace, reference] = terms.network.split(':');
  if (!namespace || !reference) unavailable();
  const memo = await reusableOpeningMemo(terms);
  await journal.beginOpening(terms, signer);
  const guarded = guardOpeningSigner(journal, terms, signer);
  const created = await new UptoSvmScheme(guarded.signer).createPaymentPayload(
    2,
    {
      scheme: 'upto',
      network: `${namespace}:${reference}`,
      asset: terms.mint,
      amount: terms.depositAtomic,
      payTo: terms.payTo,
      maxTimeoutSeconds: UPTO_CHANNEL_SETTINGS.maxTimeoutSeconds,
      extra: {
        feePayer: terms.feePayer,
        receiverAuthorizer: terms.buyer,
        withdrawDelay: terms.gracePeriod,
        tokenProgram: terms.tokenProgram,
        recentBlockhash,
        lastValidBlockHeight: terms.lastValidBlockHeight,
        recentSlot: terms.openSlot,
        splits: paymentSplits(terms),
        memo,
      },
    },
  );
  const result = payload(created.payload);
  if (
    result.authorizedSigner !== terms.buyer ||
    result.from !== terms.buyer ||
    result.deposit !== terms.depositAtomic ||
    result.maxAmount !== terms.depositAtomic ||
    result.openSlot !== terms.openSlot
  )
    unavailable();
  const bound = guarded.bound();
  if (
    !bound ||
    bound.channelId !== result.channelId ||
    bound.salt !== result.nonce
  )
    unavailable();
  return { payload: result };
}
