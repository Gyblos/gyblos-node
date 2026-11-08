// Real SDK authorization, voucher and claim over synthetic accounts/RPC; no native program executes.
import assert from 'node:assert/strict';

import { generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import type { FacilitatorSvmSigner } from '@x402/svm';
import {
  createUptoAuthorization,
  createUptoFacilitator,
  createUptoSdkChain,
  createUptoVerifier,
  decodeUptoPayload,
  memoryUptoChainStore,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_CHANNEL_STATES,
  uptoDistributionHash,
  type UptoChannelRecord,
  type UptoTerms,
} from 'x402-upto-metered';

import { DEVNET, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';

import { channelAccount, decodeSent, type SentTransaction } from './upto-withdraw-chain';

export const CLAIM_NOW = 1_800_000_000_000;

export async function sdkClaimFixture(options: { allowClosingClaims?: boolean } = {}) {
  const [payer, feePayer, authorizer, recipient, mint] = await Promise.all(
    Array.from({ length: 5 }, () => generateKeyPairSigner()),
  );
  assert.ok(payer && feePayer && authorizer && recipient && mint);
  const terms: UptoTerms = {
    network: DEVNET,
    asset: mint.address,
    payTo: recipient.address,
    feePayer: feePayer.address,
    authorizer: authorizer.address,
    tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram,
    maxAtomic: '1000',
    expiresAt: CLAIM_NOW + 30_000,
    memo: 'synthetic-claim-binding',
    withdrawDelaySeconds: UPTO_CHANNEL_SETTINGS.withdrawDelaySeconds,
    maxTimeoutSeconds: UPTO_CHANNEL_SETTINGS.maxTimeoutSeconds,
  };
  const hints = {
    recentBlockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)),
    lastValidBlockHeight: '500000000',
    recentSlot: '400000000',
  };
  const authorization = await createUptoAuthorization(payer, terms, hints);
  const payload = decodeUptoPayload(authorization);
  assert.equal(typeof payload.nonce, 'string');
  const fields = {
    payer: payer.address,
    payee: feePayer.address,
    authorizedSigner: authorizer.address,
    mint: mint.address,
    rentPayer: feePayer.address,
    status: UPTO_CHANNEL_ACCOUNT.statuses.OPEN as number,
    deposit: BigInt(terms.maxAtomic),
    settled: 0n,
    closureStartedAt: 0n,
    gracePeriod: terms.withdrawDelaySeconds,
    distributionHash: uptoDistributionHash([{ recipient: terms.payTo, bps: 10000 }]),
    salt: BigInt(payload.nonce as string),
    openSlot: BigInt(payload.openSlot),
  };
  const built = await channelAccount(fields);
  assert.equal(built.channelId, authorization.channelId);
  const sent: SentTransaction[] = [];
  const reasons: string[] = [];
  let now = CLAIM_NOW;
  const signer: FacilitatorSvmSigner = {
    getAddresses: () => [feePayer.address],
    getSigner: () => feePayer,
    getAccountInfo: async (requested) => requested === authorization.channelId ? {
      ...(await channelAccount(fields)).account,
      executable: false,
      lamports: 1n,
      space: 256n,
    } : null,
    getLatestBlockhash: async () => ({ blockhash: hints.recentBlockhash, lastValidBlockHeight: 500000000n }),
    getSlot: async () => BigInt(hints.recentSlot),
    signTransaction: async () => { throw new Error('claim fixture never broadcasts an open'); },
    simulateTransaction: async () => undefined,
    sendTransaction: async (wire) => {
      sent.push(decodeSent(wire));
      return getBase58Decoder().decode(new Uint8Array(64).fill(3));
    },
    confirmTransaction: async () => undefined,
  };
  const store = memoryUptoChainStore();
  const facilitator = createUptoFacilitator(signer, store, options);
  const chain = createUptoSdkChain({
    facilitator: { settle: async (...args) => {
      const result = await facilitator.settle(...args);
      reasons.push(result.errorReason ?? 'success');
      return result;
    } },
    verify: createUptoVerifier(feePayer.address, async () => BigInt(hints.recentSlot)),
    authorizer,
    store,
    channelExists: async () => true,
    settledClaim: async () => undefined,
    now: () => now,
    openWindowMs: 90000,
    recipients: { ensure: async () => undefined },
  });
  const record: UptoChannelRecord = { ...authorization, state: UPTO_CHANNEL_STATES.ADMITTED, terms };
  return { chain, record, fields, sent, reasons, authorization, setNow: (value: number) => { now = value; } };
}
