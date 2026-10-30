// Synthetic keys, terms and a fake chain for the package tests; nothing touches a network.
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';

import {
  UPTO_ERROR_CODES,
  UptoError,
  type UptoAuthorization,
  type UptoChain,
  type UptoChannelRecord,
  type UptoClientHints,
  type UptoTerms,
} from '../src/index';

export const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const SECRET = 'UPSTREAM-SECRET-MARKER';
export const NOW = 1_800_000_000_000;

export interface Parties {
  payer: KeyPairSigner;
  feePayer: KeyPairSigner;
  authorizer: KeyPairSigner;
  terms: UptoTerms;
  hints: UptoClientHints;
}

export async function parties(): Promise<Parties> {
  const payer = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const authorizer = await generateKeyPairSigner();
  return {
    payer,
    feePayer,
    authorizer,
    terms: {
      network: NETWORK,
      asset: (await generateKeyPairSigner()).address,
      payTo: (await generateKeyPairSigner()).address,
      feePayer: feePayer.address,
      authorizer: authorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      maxAtomic: '1030000',
      expiresAt: NOW + 60_000,
      memo: `gyblos:${'ab'.repeat(32)}`,
      withdrawDelaySeconds: 60,
      maxTimeoutSeconds: 120,
    },
    hints: {
      recentBlockhash: (await generateKeyPairSigner()).address,
      lastValidBlockHeight: '500000000',
      recentSlot: '400000000',
    },
  };
}

export type ChainEvent = 'verify' | 'deposit' | 'claim';

// A ledger-level chain with the guarantees a real one must give: a deposit either lands or not
// (channelOpen tells), a definitive refusal is a FACILITATOR_REJECTED error, and a claim is
// idempotent per channel and charge.
export function fakeChain(
  options: {
    accepts?: (authorization: UptoAuthorization) => boolean;
    failDeposit?: boolean;
    landThenFailDeposit?: boolean;
    rejectDeposit?: boolean;
    failClaim?: () => boolean;
    pause?: () => Promise<void>;
  } = {},
) {
  const events: ChainEvent[] = [];
  const claims: { channelId: string; chargedAtomic: string }[] = [];
  const open = new Set<string>();
  const claimed = new Map<
    string,
    { chargedAtomic: string; transaction: string }
  >();
  const chain: UptoChain = {
    async verify(authorization) {
      events.push('verify');
      return options.accepts?.(authorization) ?? true;
    },
    async deposit(authorization) {
      await options.pause?.();
      if (options.rejectDeposit)
        throw new UptoError(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
      if (options.failDeposit)
        throw new Error(`deposit failed at https://rpc.invalid/?k=${SECRET}`);
      events.push('deposit');
      open.add(authorization.channelId);
      if (options.landThenFailDeposit)
        throw new Error(`confirmation timed out at ${SECRET}`);
      return { transaction: 'd'.repeat(64) };
    },
    async channelOpen(channelId) {
      return open.has(channelId);
    },
    async claim(record: UptoChannelRecord, chargedAtomic: string) {
      await options.pause?.();
      const previous = claimed.get(record.channelId);
      if (previous) {
        if (previous.chargedAtomic !== chargedAtomic)
          throw new UptoError(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
        return { transaction: previous.transaction };
      }
      if (options.failClaim?.())
        throw new Error(`claim failed at https://rpc.invalid/?k=${SECRET}`);
      events.push('claim');
      claims.push({ channelId: record.channelId, chargedAtomic });
      const transaction = `c${String(claims.length).padStart(63, '0')}`;
      claimed.set(record.channelId, { chargedAtomic, transaction });
      return { transaction };
    },
  };
  return { chain, events, claims };
}

export function authorizationFor(
  terms: UptoTerms,
  overrides: Partial<UptoAuthorization> = {},
): UptoAuthorization {
  return {
    channelId: 'Chan1111111111111111111111111111111111111111',
    payer: 'Payer111111111111111111111111111111111111111',
    maxAtomic: terms.maxAtomic,
    payload: Buffer.from('{}').toString('base64'),
    ...overrides,
  };
}
