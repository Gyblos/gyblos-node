// In-memory reference pair for the payment port contract: a synthetic ledger, ed25519 signatures and
// a journal, so the contract is proven satisfiable before any real adapter exists. Never moves funds.
// Like a real adapter, the server derives the payer key from its address and keeps its own records.
import { randomBytes } from 'node:crypto';

import {
  PAYMENT_BINDING,
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import type {
  PaymentAdmission,
  PaymentAuthorization,
  PaymentClient,
  PaymentDescription,
  PaymentServer,
  PaymentSplit,
  PaymentTerms,
} from '@gyblos/protocol/payment';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import {
  ATOMIC,
  channelIdOf,
  confirmedReceipt,
  description,
  fail,
  FUNDS,
  newPayer,
  openChannel,
  OTHER_SELLER,
  sha256,
  signedSplits,
  START_MS,
  TERM_MS,
  trustedTerms,
  withTamperedSplits,
  type Channel,
  type JournalEntry,
  type Ledger,
  type PayerKey,
} from './payment-memory-ledger';
import {
  CONTRACT_CEILING,
  PAYMENT_EVENTS,
  type PaymentHarness,
  type PaymentRig,
  type PaymentRigOptions,
} from './payment-rig';
import { UPSTREAM_MARKER } from './private-error';

function createClient(
  ledger: Ledger,
  options: { failJournal: boolean; rpcUrl: string },
): PaymentClient & { key: PayerKey } {
  const key = newPayer();
  const payer = key.payer;
  const journal = new Map<string, JournalEntry>();
  return {
    key,
    async authorize(terms) {
      if (!trustedTerms(terms, payer, ledger.now))
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
      const authorization = await openChannel(key, terms, paymentSplits(terms));
      ledger.events.push(PAYMENT_EVENTS.SIGN);
      return authorization;
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
    async discard(authorization) {
      const entry = journal.get(authorization.requestDigest);
      if (!entry) return;
      if (entry.channelId !== authorization.channelId)
        fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
      if (entry.state === PAYMENT_CHANNEL_STATES.SETTLED)
        fail(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
      journal.delete(authorization.requestDigest);
    },
  };
}

// The signed distribution when the authorization matches these terms exactly, else null.
async function matchingSplits(
  own: PaymentDescription,
  authorization: PaymentAuthorization,
  terms: PaymentTerms,
): Promise<PaymentSplit[] | null> {
  if (
    !(Object.keys(own) as (keyof PaymentDescription)[]).every(
      (key) => terms[key] === own[key],
    ) ||
    terms.buyer !== authorization.payer ||
    authorization.requestDigest !== terms.requestDigest ||
    authorization.maxAtomic !== terms.maxAtomic ||
    authorization.channelId !== channelIdOf(authorization.payer, terms)
  )
    return null;
  const splits = await signedSplits(authorization, terms);
  return splits &&
    JSON.stringify(splits) === JSON.stringify(paymentSplits(terms))
    ? splits
    : null;
}

function shareOf(channel: Channel, recipient: string, charged: bigint): bigint {
  const bps = channel.splits.find(
    (split) => split.recipient === recipient,
  )?.bps;
  return (charged * BigInt(bps ?? 0)) / BigInt(PAYMENT_BINDING.bpsDenominator);
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
  depositSent: () => void,
  lapseClaims = false,
): PaymentServer {
  const channels = new Map<string, Channel>();
  return {
    describe: async () => ({ ...own }),
    async admit(authorization, terms, options = {}) {
      options.signal?.throwIfAborted();
      let splits: PaymentSplit[] | null = null;
      try {
        splits = await matchingSplits(own, authorization, terms);
      } catch {
        splits = null;
      }
      if (!splits) return fail(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH);
      if (channels.has(authorization.channelId))
        fail(PAYMENT_ERROR_CODES.CHANNEL_REUSED);
      if (terms.expiresAt <= ledger.now)
        fail(PAYMENT_ERROR_CODES.TERMS_EXPIRED);
      // Last point the caller can still cancel: after this the deposit is sent.
      options.signal?.throwIfAborted();
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
      channels.set(authorization.channelId, {
        ...admission,
        splits,
        settlement: null,
      });
      ledger.balances.payer -= maxAtomic;
      ledger.balances.escrow += maxAtomic;
      ledger.events.push(PAYMENT_EVENTS.DEPOSIT);
      depositSent();
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
      // A claim refused for good charges nothing; the payer recovers the deposit on its own.
      if (lapseClaims) return fail(PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED);
      const charged = BigInt(chargedAtomic);
      const seller = shareOf(channel, own.payTo, charged);
      const fee = shareOf(channel, own.treasury, charged);
      const settlement = {
        channelId: channel.channelId,
        chargedAtomic: String(charged),
        refundedAtomic: String(ceiling - charged),
        sellerAtomic: String(seller),
        feeAtomic: String(fee),
        transaction: randomBytes(32).toString('hex'),
      };
      channel.settlement = settlement;
      // Rounding dust (charged - seller - fee) goes to the program's own treasury, not modelled.
      ledger.balances.escrow -= ceiling;
      ledger.balances.payee += seller;
      ledger.balances.treasury += fee;
      ledger.balances.payer += ceiling - charged;
      const { transaction: _transaction, ...onChain } = settlement;
      ledger.transactions.set(settlement.transaction, onChain);
      ledger.events.push(PAYMENT_EVENTS.SETTLE);
      return settlement;
    },
  };
}

export const memoryPaymentHarness: PaymentHarness = {
  async start(options: PaymentRigOptions): Promise<PaymentRig> {
    const ledger: Ledger = {
      now: START_MS,
      balances: { payer: FUNDS, payee: 0n, treasury: 0n, escrow: 0n },
      events: [],
      transactions: new Map(),
    };
    const rpcUrl = `https://rpc.invalid/?api-key=${UPSTREAM_MARKER}`;
    const depositSent = () => options.onDepositSent?.();
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
      server: createServer(
        ledger,
        own,
        upstream,
        depositSent,
        options.lapseClaims,
      ),
      serverWith: async (field) =>
        createServer(
          ledger,
          { ...own, [field]: OTHER_SELLER[field] },
          upstream,
          depositSent,
        ),
      foreignAuthorization: (terms) =>
        openChannel(newPayer(), terms, paymentSplits(terms)),
      authorizationWithSplits: (terms, splits) =>
        openChannel(client.key, terms, splits),
      tamperSplits: async (authorization, splits) =>
        withTamperedSplits(authorization, splits),
      terms: async (overrides = {}) => ({
        ...own,
        buyer: client.key.payer,
        requestDigest,
        maxAtomic: String(CONTRACT_CEILING),
        expiresAt: ledger.now + TERM_MS,
        ...overrides,
      }),
      observe: () => ({
        events: [...ledger.events],
        balances: { ...ledger.balances },
      }),
      now: () => ledger.now,
      advance(ms) {
        ledger.now += ms;
      },
      async close() {},
    };
  },
};
