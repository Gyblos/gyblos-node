// In-memory reference pair for the payment port contract: a synthetic ledger, ed25519 signatures and
// a journal, so the contract is proven satisfiable before any real adapter exists. Never moves funds.
// Like a real adapter, the server derives the payer key from its address and keeps its own records.
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentDescription,
  type PaymentReconciliation,
  type PaymentServer,
  type PaymentSettlement,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import {
  CONTRACT_CEILING,
  CONTRACT_NOW,
  PAYMENT_EVENTS,
  type PaymentBalances,
  type PaymentEvent,
  type PaymentHarness,
  type PaymentRig,
  type PaymentRigOptions,
} from './payment-rig';
import { UPSTREAM_MARKER } from './private-error';

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FUNDS = 10n * CONTRACT_CEILING;
const TERM_MS = 60_000;
const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MINT = 'mint-synthetic';

interface Ledger {
  balances: PaymentBalances;
  events: PaymentEvent[];
  // What actually happened on the synthetic chain, by transaction id.
  transactions: Map<string, Omit<PaymentSettlement, 'transaction'>>;
}

interface JournalEntry extends PaymentReconciliation {
  maxAtomic: string;
}

interface Channel extends PaymentAdmission {
  settlement: PaymentSettlement | null;
}

function fail(code: PaymentErrorCode): never {
  throw new PaymentError(code);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function description(name: string): PaymentDescription {
  return {
    network: NETWORK,
    mint: MINT,
    payTo: `payee-${name}`,
    feePayer: `fee-payer-${name}`,
    authorizer: `authorizer-${name}`,
  };
}

function channelIdOf(payer: string, terms: PaymentTerms): string {
  return sha256(JSON.stringify([payer, terms.payTo, terms.requestDigest]));
}

// Everything a payer signs: the channel and every money-binding field of the terms.
function signedBytes(channelId: string, terms: PaymentTerms): Buffer {
  return Buffer.from(
    JSON.stringify([
      channelId,
      terms.buyer,
      terms.network,
      terms.mint,
      terms.payTo,
      terms.feePayer,
      terms.authorizer,
      terms.requestDigest,
      terms.maxAtomic,
      terms.expiresAt,
    ]),
  );
}

function trustedTerms(terms: PaymentTerms, payer: string): boolean {
  return (
    terms.network === NETWORK &&
    terms.mint === MINT &&
    terms.buyer === payer &&
    ATOMIC.test(terms.maxAtomic) &&
    BigInt(terms.maxAtomic) > 0n &&
    BigInt(terms.maxAtomic) <= CONTRACT_CEILING &&
    DIGEST.test(terms.requestDigest) &&
    terms.expiresAt > CONTRACT_NOW
  );
}

function confirmedReceipt(
  ledger: Ledger,
  entry: JournalEntry,
  settlement: PaymentSettlement,
  expectedChargedAtomic: string,
): boolean {
  const onChain = ledger.transactions.get(settlement.transaction);
  return (
    onChain !== undefined &&
    onChain.channelId === entry.channelId &&
    settlement.channelId === entry.channelId &&
    onChain.chargedAtomic === settlement.chargedAtomic &&
    onChain.refundedAtomic === settlement.refundedAtomic &&
    settlement.chargedAtomic === expectedChargedAtomic &&
    BigInt(onChain.chargedAtomic) + BigInt(onChain.refundedAtomic) ===
      BigInt(entry.maxAtomic)
  );
}

function createClient(
  ledger: Ledger,
  options: { failJournal: boolean; rpcUrl: string },
): PaymentClient & { payer: string } {
  const keys = generateKeyPairSync('ed25519');
  const payer = keys.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('hex');
  const journal = new Map<string, JournalEntry>();
  return {
    payer,
    async authorize(terms) {
      if (!trustedTerms(terms, payer))
        fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
      if (journal.has(terms.requestDigest))
        fail(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED);
      // A real journal would also keep the RPC origin for recovery; it is never echoed in errors.
      if (options.failJournal || !options.rpcUrl)
        fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
      const channelId = channelIdOf(payer, terms);
      journal.set(terms.requestDigest, {
        channelId,
        requestDigest: terms.requestDigest,
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
        maxAtomic: terms.maxAtomic,
      });
      ledger.events.push(PAYMENT_EVENTS.JOURNAL);
      const signature = sign(
        null,
        signedBytes(channelId, terms),
        keys.privateKey,
      );
      ledger.events.push(PAYMENT_EVENTS.SIGN);
      return {
        channelId,
        payer,
        requestDigest: terms.requestDigest,
        maxAtomic: terms.maxAtomic,
        payload: signature.toString('base64'),
      };
    },
    async checkReceipt(authorization, settlement, expectedChargedAtomic) {
      const entry = journal.get(authorization.requestDigest);
      if (!entry || entry.channelId !== authorization.channelId)
        fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
      if (entry.state === PAYMENT_CHANNEL_STATES.SETTLED)
        fail(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
      if (!confirmedReceipt(ledger, entry, settlement, expectedChargedAtomic))
        fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
      journal.set(authorization.requestDigest, {
        ...entry,
        state: PAYMENT_CHANNEL_STATES.SETTLED,
        chargedAtomic: settlement.chargedAtomic,
      });
    },
    async reconcile() {
      return [...journal.values()].map(
        ({ channelId, requestDigest, state, chargedAtomic }) => ({
          channelId,
          requestDigest,
          state,
          chargedAtomic,
        }),
      );
    },
  };
}

function payerKey(payer: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(payer, 'hex'),
    format: 'der',
    type: 'spki',
  });
}

function matches(
  own: PaymentDescription,
  authorization: PaymentAuthorization,
  terms: PaymentTerms,
): boolean {
  const payload = Buffer.from(authorization.payload, 'base64');
  return (
    (Object.keys(own) as (keyof PaymentDescription)[]).every(
      (key) => terms[key] === own[key],
    ) &&
    terms.expiresAt > CONTRACT_NOW &&
    terms.buyer === authorization.payer &&
    authorization.requestDigest === terms.requestDigest &&
    authorization.maxAtomic === terms.maxAtomic &&
    authorization.channelId === channelIdOf(authorization.payer, terms) &&
    // Base64 decoding ignores trailing garbage; the payload must round-trip exactly.
    payload.toString('base64') === authorization.payload &&
    verify(
      null,
      signedBytes(authorization.channelId, terms),
      payerKey(authorization.payer),
      payload,
    )
  );
}

function sameAdmission(channel: Channel, admission: PaymentAdmission): boolean {
  return (
    channel.payer === admission.payer &&
    channel.requestDigest === admission.requestDigest &&
    channel.maxAtomic === admission.maxAtomic
  );
}

function createServer(
  ledger: Ledger,
  own: PaymentDescription,
  upstream: () => void,
): PaymentServer {
  const channels = new Map<string, Channel>();
  return {
    describe: async () => ({ ...own }),
    async admit(authorization, terms) {
      let valid = false;
      try {
        valid = matches(own, authorization, terms);
      } catch {
        valid = false;
      }
      if (!valid) fail(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH);
      if (channels.has(authorization.channelId))
        fail(PAYMENT_ERROR_CODES.CHANNEL_REUSED);
      const maxAtomic = BigInt(authorization.maxAtomic);
      try {
        upstream();
      } catch {
        fail(PAYMENT_ERROR_CODES.UNAVAILABLE);
      }
      if (ledger.balances.payer < maxAtomic)
        fail(PAYMENT_ERROR_CODES.UNAVAILABLE);
      const admission = {
        channelId: authorization.channelId,
        payer: authorization.payer,
        requestDigest: authorization.requestDigest,
        maxAtomic: authorization.maxAtomic,
      };
      channels.set(authorization.channelId, { ...admission, settlement: null });
      ledger.balances.payer -= maxAtomic;
      ledger.balances.escrow += maxAtomic;
      ledger.events.push(PAYMENT_EVENTS.DEPOSIT);
      return admission;
    },
    async settle(admission, chargedAtomic) {
      const channel = channels.get(admission.channelId);
      if (!channel || !sameAdmission(channel, admission))
        return fail(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH);
      if (channel.settlement)
        return channel.settlement.chargedAtomic === chargedAtomic
          ? channel.settlement
          : fail(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
      const ceiling = BigInt(channel.maxAtomic);
      if (!ATOMIC.test(chargedAtomic) || BigInt(chargedAtomic) > ceiling)
        fail(PAYMENT_ERROR_CODES.INVALID_CHARGE);
      const charged = BigInt(chargedAtomic);
      const settlement = {
        channelId: channel.channelId,
        chargedAtomic: String(charged),
        refundedAtomic: String(ceiling - charged),
        transaction: randomBytes(32).toString('hex'),
      };
      channel.settlement = settlement;
      ledger.balances.escrow -= ceiling;
      ledger.balances.payee += charged;
      ledger.balances.payer += ceiling - charged;
      ledger.transactions.set(settlement.transaction, {
        channelId: settlement.channelId,
        chargedAtomic: settlement.chargedAtomic,
        refundedAtomic: settlement.refundedAtomic,
      });
      ledger.events.push(PAYMENT_EVENTS.SETTLE);
      return settlement;
    },
  };
}

export const memoryPaymentHarness: PaymentHarness = {
  async start(options: PaymentRigOptions): Promise<PaymentRig> {
    const ledger: Ledger = {
      balances: { payer: FUNDS, payee: 0n, escrow: 0n },
      events: [],
      transactions: new Map(),
    };
    const rpcUrl = `https://rpc.invalid/?api-key=${UPSTREAM_MARKER}`;
    const upstream = () => {
      if (options.failUpstream) throw new Error(`RPC failed at ${rpcUrl}`);
    };
    const client = createClient(ledger, {
      failJournal: options.failJournal,
      rpcUrl,
    });
    const own = description('primary');
    const requestDigest = sha256('contract request');
    return {
      client,
      server: createServer(ledger, own, upstream),
      serverWith: (overrides) =>
        createServer(ledger, { ...own, ...overrides }, upstream),
      async foreignAuthorization(terms) {
        const keys = generateKeyPairSync('ed25519');
        const payer = keys.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('hex');
        const channelId = channelIdOf(payer, terms);
        return {
          channelId,
          payer,
          requestDigest: terms.requestDigest,
          maxAtomic: terms.maxAtomic,
          payload: sign(
            null,
            signedBytes(channelId, terms),
            keys.privateKey,
          ).toString('base64'),
        };
      },
      terms: async (overrides = {}) => ({
        ...own,
        buyer: client.payer,
        requestDigest,
        maxAtomic: String(CONTRACT_CEILING),
        expiresAt: CONTRACT_NOW + TERM_MS,
        ...overrides,
      }),
      observe: () => ({
        events: [...ledger.events],
        balances: { ...ledger.balances },
      }),
      async close() {},
    };
  },
};
