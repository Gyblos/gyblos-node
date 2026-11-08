// The payment contract harness for @gyblos/payments-upto: the real x402 upto SDK signs and verifies
// channel opens offline (including the 3% distribution), the x402-upto-metered seller keeps its
// write-ahead records, and a synthetic ledger stands in for the chain. No network or real funds.
import { createHash } from 'node:crypto';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  address,
  generateKeyPairSigner,
  type KeyPairSigner,
} from '@solana/kit';
import {
  createUptoAuthorization,
  createUptoSeller,
  createUptoVerifier,
  memoryUptoStore,
  type UptoClientHints,
  type UptoStore,
} from 'x402-upto-metered';

import {
  createUptoPaymentServer,
  uptoSellerTerms,
  uptoTermsFor,
  type UptoChannelSettings,
} from '@gyblos/payments-upto';
import type {
  PaymentAuthorization,
  PaymentDescription,
  PaymentSplit,
  PaymentTerms,
} from '@gyblos/protocol/payment';

import {
  CONTRACT_CEILING,
  type PaymentHarness,
  type PaymentRig,
  type PaymentRigOptions,
  type SellerKey,
} from './payment-rig';
import { uptoContractClient } from './payment-upto-client';
import { ledgerChain, newLedger, type UptoLedger } from './payment-upto-ledger';

export const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const START_MS = 1_800_000_000_000;
const TERM_MS = 60_000;
export const FEE_BPS = 300;
export const SETTINGS: UptoChannelSettings = {
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
  withdrawDelaySeconds: 300,
  maxTimeoutSeconds: 120,
};

export const newAddress = async () => (await generateKeyPairSigner()).address;

export async function hints(): Promise<UptoClientHints> {
  return {
    recentBlockhash: await newAddress(),
    lastValidBlockHeight: '500000000',
    recentSlot: '400000000',
  };
}

// A fresh channel store for one seller; disposers run when the rig closes.
export type UptoStoreFactory = (
  dispose: (cleanup: () => Promise<void>) => void,
) => Promise<UptoStore>;

export function seller(
  ledger: UptoLedger,
  description: PaymentDescription,
  slot: string,
  options: Pick<
    PaymentRigOptions,
    'failUpstream' | 'onDepositSent' | 'lapseClaims'
  >,
  store: UptoStore = memoryUptoStore(),
) {
  const chain = ledgerChain(
    ledger,
    createUptoVerifier(address(description.feePayer), async () => BigInt(slot)),
    options,
  );
  return createUptoPaymentServer({
    description,
    settings: SETTINGS,
    now: () => ledger.now,
    seller: createUptoSeller({
      chain,
      store,
      now: () => ledger.now,
      own: uptoSellerTerms(description, SETTINGS),
    }),
  });
}

// A distribution the SDK refuses to sign (treasury first) cannot be produced through the SDK; for
// that one contract case this stands in an open that can never verify, so the case only proves
// such a payload is refused. The distributions the SDK can sign carry the real enforcement.
async function signedWith(
  payer: KeyPairSigner,
  terms: PaymentTerms,
  splits: readonly PaymentSplit[],
  recent: UptoClientHints,
): Promise<PaymentAuthorization> {
  const base = await uptoTermsFor(terms, SETTINGS);
  try {
    const signed = await createUptoAuthorization(
      payer,
      { ...base, splits },
      recent,
    );
    return { ...signed, requestDigest: terms.requestDigest };
  } catch {
    return {
      channelId: payer.address,
      payer: payer.address,
      requestDigest: terms.requestDigest,
      maxAtomic: terms.maxAtomic,
      payload: Buffer.from('{}').toString('base64'),
    };
  }
}

export function uptoHarness(newStore: UptoStoreFactory): PaymentHarness {
  return { start: (options) => startRig(options, newStore) };
}

export const uptoPaymentHarness = uptoHarness(async () => memoryUptoStore());

async function startRig(
  options: PaymentRigOptions,
  newStore: UptoStoreFactory,
): Promise<PaymentRig> {
  const disposers: (() => Promise<void>)[] = [];
  const store = () => newStore((cleanup) => disposers.push(cleanup));
  // The SDK timestamps authorizations with Date.now(); begin this controllable clock there too.
  const ledger = newLedger(Date.now());
  const recent = await hints();
  const payer = await generateKeyPairSigner();
  const description: PaymentDescription = {
    network: NETWORK,
    mint: await newAddress(),
    payTo: await newAddress(),
    feePayer: await newAddress(),
    authorizer: await newAddress(),
    protocolFeeBps: FEE_BPS,
    treasury: await newAddress(),
  };
  const others: Record<SellerKey, PaymentDescription[SellerKey]> = {
    payTo: await newAddress(),
    feePayer: await newAddress(),
    authorizer: await newAddress(),
    protocolFeeBps: FEE_BPS + 1,
    treasury: await newAddress(),
  };
  const requestDigest = createHash('sha256')
    .update('contract request')
    .digest('hex');
  return {
    client: uptoContractClient({
      payer,
      policy: description,
      maxAtomic: CONTRACT_CEILING,
      settings: SETTINGS,
      hints: recent,
      ledger,
      failJournal: options.failJournal,
    }),
    server: seller(
      ledger,
      description,
      recent.recentSlot,
      options,
      await store(),
    ),
    serverWith: async (field) =>
      seller(
        ledger,
        { ...description, [field]: others[field] },
        recent.recentSlot,
        options,
        await store(),
      ),
    foreignAuthorization: async (terms) =>
      signedWith(
        await generateKeyPairSigner(),
        terms,
        (await uptoTermsFor(terms, SETTINGS)).splits ?? [],
        recent,
      ),
    authorizationWithSplits: (terms, splits) =>
      signedWith(payer, terms, splits, recent),
    // The open of a separately signed authorization spliced into the original payload. Its channel
    // and nonce differ too, so this proves a spliced open is refused, not which field refused it.
    async tamperSplits(authorization, splits) {
      const original = JSON.parse(
        Buffer.from(authorization.payload, 'base64').toString(),
      );
      const terms = rigTerms({});
      const other = await signedWith(payer, terms, splits, recent);
      const replaced = JSON.parse(
        Buffer.from(other.payload, 'base64').toString(),
      );
      return {
        ...authorization,
        payload: Buffer.from(
          JSON.stringify({
            ...original,
            openTransaction: replaced.openTransaction,
          }),
        ).toString('base64'),
      };
    },
    terms: async (overrides = {}) => rigTerms(overrides),
    observe: () => ({
      events: [...ledger.events],
      balances: { ...ledger.balances },
    }),
    now: () => ledger.now,
    advance(ms) {
      ledger.now += ms;
    },
    async close() {
      // Last registered first, like a stack: a store closes before its directory goes.
      for (const cleanup of disposers.reverse()) await cleanup();
    },
  };

  function rigTerms(overrides: Partial<PaymentTerms>): PaymentTerms {
    return {
      ...description,
      buyer: payer.address,
      requestDigest,
      maxAtomic: String(CONTRACT_CEILING),
      expiresAt: ledger.now + TERM_MS,
      ...overrides,
    };
  }
}
