// In-memory reference pair for the payment port contract: a synthetic ledger, ed25519 signatures and
// a journal, so the contract is proven satisfiable before any real adapter exists. Never moves funds.
import {
  createHash,
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
  type PaymentEvent,
  type PaymentHarness,
  type PaymentRig,
} from './payment-contract';

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FUNDS = 10n * CONTRACT_CEILING;
const TERM_SECONDS = 60_000;
const DESCRIPTION: PaymentDescription = {
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  mint: 'mint-synthetic',
  payTo: 'payee-synthetic',
  feePayer: 'fee-payer-synthetic',
  authorizer: 'authorizer-synthetic',
};

interface Ledger {
  balances: { payer: bigint; payee: bigint; escrow: bigint };
  events: PaymentEvent[];
  publicKeys: Map<string, KeyObject>;
}

interface Channel {
  maxAtomic: bigint;
  settled: boolean;
}

function fail(code: PaymentErrorCode): never {
  throw new PaymentError(code);
}

function atomic(value: string, code: PaymentErrorCode): bigint {
  return ATOMIC.test(value) ? BigInt(value) : fail(code);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// The fields a payer signs: everything that binds the deposit to one request and one payee.
function signedFields(
  authorization: Omit<PaymentAuthorization, 'payload'>,
  terms: PaymentTerms,
) {
  return JSON.stringify([
    authorization.channelId,
    authorization.payer,
    authorization.requestDigest,
    authorization.maxAtomic,
    terms.network,
    terms.mint,
    terms.payTo,
    terms.expiresAt,
  ]);
}

function createClient(
  ledger: Ledger,
  options: { failJournal: boolean; rpcUrl: string },
): PaymentClient & { payer: string } {
  const keys = generateKeyPairSync('ed25519');
  const payer = keys.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('hex');
  ledger.publicKeys.set(payer, keys.publicKey);
  const journal = new Map<string, PaymentReconciliation>();
  const trusted = (terms: PaymentTerms) =>
    terms.network === DESCRIPTION.network &&
    terms.mint === DESCRIPTION.mint &&
    terms.buyer === payer &&
    ATOMIC.test(terms.maxAtomic) &&
    BigInt(terms.maxAtomic) <= CONTRACT_CEILING &&
    DIGEST.test(terms.requestDigest) &&
    terms.expiresAt > CONTRACT_NOW;
  return {
    payer,
    async authorize(terms) {
      if (!trusted(terms)) fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
      if (journal.has(terms.requestDigest))
        fail(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED);
      // A real journal would also hold the RPC origin for recovery; it is never echoed in errors.
      if (options.failJournal || !options.rpcUrl)
        fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
      const channelId = sha256(`${payer}:${terms.requestDigest}`);
      journal.set(terms.requestDigest, {
        channelId,
        requestDigest: terms.requestDigest,
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
      });
      ledger.events.push('journal');
      const unsigned = {
        channelId,
        payer,
        requestDigest: terms.requestDigest,
        maxAtomic: terms.maxAtomic,
      };
      const signature = sign(
        null,
        Buffer.from(signedFields(unsigned, terms)),
        keys.privateKey,
      );
      ledger.events.push('sign');
      return { ...unsigned, payload: signature.toString('base64') };
    },
    async checkReceipt(authorization, settlement, expectedChargedAtomic) {
      const charged = atomic(
        settlement.chargedAtomic,
        PAYMENT_ERROR_CODES.RECEIPT_MISMATCH,
      );
      const refunded = atomic(
        settlement.refundedAtomic,
        PAYMENT_ERROR_CODES.RECEIPT_MISMATCH,
      );
      const entry = journal.get(authorization.requestDigest);
      if (
        !entry ||
        settlement.channelId !== entry.channelId ||
        settlement.chargedAtomic !== expectedChargedAtomic ||
        charged + refunded !== BigInt(authorization.maxAtomic)
      )
        fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
      journal.set(authorization.requestDigest, {
        ...entry,
        state: PAYMENT_CHANNEL_STATES.SETTLED,
        chargedAtomic: settlement.chargedAtomic,
      });
    },
    async reconcile() {
      return [...journal.values()];
    },
  };
}

function verified(
  ledger: Ledger,
  authorization: PaymentAuthorization,
  terms: PaymentTerms,
): boolean {
  const publicKey = ledger.publicKeys.get(authorization.payer);
  return (
    publicKey !== undefined &&
    authorization.requestDigest === terms.requestDigest &&
    authorization.maxAtomic === terms.maxAtomic &&
    authorization.channelId ===
      sha256(`${authorization.payer}:${authorization.requestDigest}`) &&
    verify(
      null,
      Buffer.from(signedFields(authorization, terms)),
      publicKey,
      Buffer.from(authorization.payload, 'base64'),
    ) &&
    // Base64 decoding ignores trailing garbage; the payload must round-trip exactly.
    Buffer.from(authorization.payload, 'base64').toString('base64') ===
      authorization.payload
  );
}

function createServer(ledger: Ledger): PaymentServer {
  const channels = new Map<string, Channel>();
  const ownTerms = (terms: PaymentTerms) =>
    (Object.keys(DESCRIPTION) as (keyof PaymentDescription)[]).every(
      (key) => terms[key] === DESCRIPTION[key],
    ) && terms.expiresAt > CONTRACT_NOW;
  return {
    describe: () => ({ ...DESCRIPTION }),
    async admit(authorization, terms): Promise<PaymentAdmission> {
      let valid = false;
      try {
        valid = ownTerms(terms) && verified(ledger, authorization, terms);
      } catch {
        valid = false;
      }
      if (!valid) fail(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH);
      if (channels.has(authorization.channelId))
        fail(PAYMENT_ERROR_CODES.CHANNEL_REUSED);
      const maxAtomic = BigInt(authorization.maxAtomic);
      if (ledger.balances.payer < maxAtomic)
        fail(PAYMENT_ERROR_CODES.UNAVAILABLE);
      channels.set(authorization.channelId, { maxAtomic, settled: false });
      ledger.balances.payer -= maxAtomic;
      ledger.balances.escrow += maxAtomic;
      ledger.events.push('deposit');
      return {
        channelId: authorization.channelId,
        payer: authorization.payer,
        requestDigest: authorization.requestDigest,
        maxAtomic: authorization.maxAtomic,
      };
    },
    async settle(admission, chargedAtomic): Promise<PaymentSettlement> {
      const channel = channels.get(admission.channelId);
      if (!channel) return fail(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH);
      if (channel.settled) fail(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
      const charged = atomic(chargedAtomic, PAYMENT_ERROR_CODES.INVALID_CHARGE);
      if (charged > channel.maxAtomic) fail(PAYMENT_ERROR_CODES.INVALID_CHARGE);
      const refunded = channel.maxAtomic - charged;
      channel.settled = true;
      ledger.balances.escrow -= channel.maxAtomic;
      ledger.balances.payee += charged;
      ledger.balances.payer += refunded;
      ledger.events.push('settle');
      return {
        channelId: admission.channelId,
        chargedAtomic: String(charged),
        refundedAtomic: String(refunded),
        transaction: randomBytes(32).toString('hex'),
      };
    },
  };
}

export const memoryPaymentHarness: PaymentHarness = {
  async start(options): Promise<PaymentRig> {
    const ledger: Ledger = {
      balances: { payer: FUNDS, payee: 0n, escrow: 0n },
      events: [],
      publicKeys: new Map(),
    };
    const client = createClient(ledger, {
      failJournal: options.failJournal,
      rpcUrl: `https://rpc.invalid/?api-key=${options.secret}`,
    });
    const requestDigest = sha256('contract request');
    return {
      client,
      server: createServer(ledger),
      terms: (overrides = {}) => ({
        ...DESCRIPTION,
        buyer: client.payer,
        requestDigest,
        maxAtomic: String(CONTRACT_CEILING),
        expiresAt: CONTRACT_NOW + TERM_SECONDS,
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
