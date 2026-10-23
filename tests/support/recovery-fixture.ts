// Builds a recovery scenario from the payment fixture: temporary P2P root, saved journal and a
// synthetic signed offer.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPairSigner } from '@solana/kit';

import { P2P_JOURNAL_STATES } from '@gyblos/buyer/constants';
import {
  DEVNET,
  FILE_MODES,
  INFERENCE_REQUEST_LIMITS,
  MAX_ATOMIC,
  P2P,
} from '@gyblos/config';
import { PRICES } from '@gyblos/core/constants';
import type { OfferTrust } from '@gyblos/core/offers';
import { P2P_ROLES, ROLE_CONFIG_SCHEMA_VERSION } from '@gyblos/node/constants';
import { signInferenceOffer } from '@gyblos/node/offers';
import type { RoleConfig } from '@gyblos/node/roles';
import { GYBLOS_ALPN, OFFER_SCHEMA_VERSION } from '@gyblos/protocol/constants';
import type { InferenceOffer } from '@gyblos/protocol/offer';
import { loadJson, saveJson } from '@gyblos/runtime';

import { paymentFixture, withOfflineProof } from './payment-fixture.js';
import { fullPrincipalRefund, tokenCredit } from './payment-mutations.js';

export async function recoveryFixture(fullRefund = true) {
  const financial = await paymentFixture();
  if (fullRefund) await fullPrincipalRefund(financial);
  await tokenCredit(financial, 17n);
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-public-recovery-'));
  const {
    rpcUrl,
    channelId,
    ceiling,
    depositSignature,
    claimSignature,
    ...identities
  } = financial.expected;
  // This unfunded ephemeral key signs only a local synthetic OFFER, never a payment.
  const owner = await generateKeyPairSigner();
  const offer: InferenceOffer = {
    schemaVersion: OFFER_SCHEMA_VERSION,
    protocol: GYBLOS_ALPN,
    owner: owner.address,
    nodeId: '1'.repeat(64),
    endpoint: { relayUrl: null, directAddresses: [] },
    relayOnly: false,
    network: DEVNET,
    mint: identities.mint,
    payTo: identities.payTo,
    feePayer: identities.feePayer,
    authorizer: identities.authorizer,
    buyer: identities.buyer,
    issuedAt: 1,
    expiresAt: 1 + P2P.offerLifetimeMs,
    prices: PRICES,
    maxAtomic: MAX_ATOMIC,
    maxTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens,
    model: {
      name: 'synthetic-model',
      digest: 'synthetic-digest',
      contextTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens,
    },
    capabilities: {
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: 'digest',
    },
    meteringMode: 'recounted',
  };
  const trust: OfferTrust = {
    owner: owner.address,
    nodeId: offer.nodeId,
    mint: identities.mint,
    payTo: identities.payTo,
    buyer: identities.buyer,
    maxAtomic: MAX_ATOMIC,
  };
  const config: RoleConfig = {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    rpcUrl,
    mint: identities.mint,
    assetLabel: 'devnet-test-token',
    nodeId: '2'.repeat(64),
    role: P2P_ROLES.BUYER,
    buyer: identities.buyer,
  };
  const journal = {
    state: P2P_JOURNAL_STATES.AUTHORIZED,
    requestId: 'synthetic-recovery',
    channelId,
    ceiling,
    paymentExpectation: identities,
    depositSignature,
    claimSignature,
  };
  const path = (filename: string) => join(directory, P2P.root, filename);
  const write = (filename: string, value: unknown) =>
    saveJson(path(filename), value);
  try {
    await write(P2P.roleConfig, config);
    await write(P2P.trustFilename, trust);
    await write(P2P.offerFilename, await signInferenceOffer(offer, owner));
    await write(P2P.journalFilename, journal);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    financial,
    directory,
    journal,
    path,
    write,
    read: <T>(filename: string) => loadJson<T>(path(filename)),
    async run(args: string[] = []) {
      const { main } = await import('@gyblos/buyer/reconcile');
      const originalDirectory = process.cwd();
      const originalLog = console.log;
      try {
        process.chdir(directory);
        console.log = () => {};
        return await withOfflineProof(financial, () => main(args));
      } finally {
        process.chdir(originalDirectory);
        console.log = originalLog;
      }
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
