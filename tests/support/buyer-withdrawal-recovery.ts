// Actual journal, SDK opening and withdrawal over a synthetic finalized chain in a temporary home.
// Keys are ephemeral and unfunded; no RPC, engine or real role state is read.
import assert from 'node:assert/strict';

import { address } from '@solana/kit';
import {
  createUptoWithdrawal,
  decodeUptoPayload,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_WITHDRAW_STEPS,
  uptoDistributionHash,
  type UptoWithdrawalAttempt,
  type UptoWithdrawalRecovery,
} from 'x402-upto-metered';

import type { UptoBuyerJournal } from '@gyblos/payments-upto';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import { OPENING_DIGEST, openingFixture } from './opening';
import { channelAccount, withdrawChain } from './upto-withdraw-chain';

export async function withdrawalFixture(root: string) {
  const opening = await openingFixture(root);
  const authorization = await opening.client.authorize(opening.terms);
  const payload = decodeUptoPayload(authorization);
  assert.equal(typeof payload.nonce, 'string');
  const splits = paymentSplits(opening.terms);
  const fields = {
    payer: opening.payer.address,
    payee: address(opening.terms.feePayer),
    authorizedSigner: address(opening.terms.authorizer),
    mint: address(opening.terms.mint),
    rentPayer: address(opening.terms.feePayer),
    status: UPTO_CHANNEL_ACCOUNT.statuses.OPEN,
    deposit: 1000n,
    settled: 0n,
    closureStartedAt: 0n,
    gracePeriod: 300,
    distributionHash: uptoDistributionHash(splits),
    salt: BigInt(String(payload.nonce)),
    openSlot: BigInt(payload.openSlot),
  };
  const channel = await channelAccount(fields);
  assert.equal(channel.channelId, authorization.channelId);
  const state = {
    accounts: new Map([[channel.channelId, channel.account]]),
    blockTime: 1800000000n,
    slot: 400000000n,
    height: 900n,
    outcome: { err: null, confirmationStatus: 'confirmed', slot: 400000000n },
  };
  const chain = withdrawChain(state);
  const rpc = {
    ...chain.rpc,
    getEpochInfo: () => ({
      send: async () => ({
        absoluteSlot: state.slot,
        blockHeight: state.height,
      }),
    }),
    getAccountInfo: (...args: Parameters<typeof chain.rpc.getAccountInfo>) => ({
      async send(options?: { abortSignal?: AbortSignal }) {
        return {
          ...(await chain.rpc.getAccountInfo(...args).send(options!)),
          context: { slot: state.slot },
        };
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [state.outcome],
        context: { slot: state.slot },
      }),
    }),
  };
  let signatures = 0;
  const run = (recovery: UptoWithdrawalRecovery) =>
    createUptoWithdrawal(rpc, {
      payer: {
        address: opening.payer.address,
        async signTransactions(...args) {
          signatures++;
          return opening.payer.signTransactions(...args);
        },
      },
      network: opening.terms.network,
      tokenProgram: opening.options.settings.tokenProgram,
      sleep: async () => {},
    }).withdraw(
      {
        channelId: channel.channelId,
        mint: opening.terms.mint,
        rentPayer: opening.terms.feePayer,
        maxAtomic: '1000',
        splits,
      },
      recovery,
    );
  const context = async (
    journal: UptoBuyerJournal = opening.journal,
  ): Promise<UptoWithdrawalRecovery> => {
    const entry = await journal.get(OPENING_DIGEST);
    assert.ok(entry);
    return {
      previous: entry.withdrawal,
      save: async (next) =>
        journal.recordWithdrawal!(
          OPENING_DIGEST,
          channel.channelId,
          entry.withdrawal,
          next,
        ),
    };
  };
  const attempt = (transaction: string): UptoWithdrawalAttempt => ({
    step: UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED,
    transaction,
    lastValidBlockHeight: '900',
    checkedSlot: String(state.slot),
    pending: true,
  });
  return {
    ...opening,
    ...chain,
    rpc,
    state,
    fields,
    run,
    context,
    attempt,
    signatures: () => signatures,
  };
}
