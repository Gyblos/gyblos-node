// Real payment adapters and private journals over an offline synthetic chain; never constructs RPC or facilitator clients.
import assert from 'node:assert/strict';

import { address, generateKeyPairSigner } from '@solana/kit';
import { createUptoSeller, createUptoVerifier } from 'x402-upto-metered';

import {
  buyerJournalPathsIn,
  DEVNET,
  paymentPathsIn,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import { roleSigner, type RoleConfig } from '@gyblos/node/roles';
import {
  createUptoPaymentClient,
  createUptoPaymentServer,
  LEDGER_FILE,
  openUptoBuyerJournal,
  openUptoFileLedger,
  UPTO_SELLER,
  uptoSellerTerms,
} from '@gyblos/payments-upto';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type {
  PaymentAuthorization,
  PaymentClient,
  PaymentDescription,
  PaymentSettlement,
} from '@gyblos/protocol/payment';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import { ledgerChain, newLedger } from './payment-upto-ledger';

export async function paidAcceptancePayments(role: RoleConfig) {
  assert.ok(role.role === P2P_ROLES.SELLER);
  assert.ok(role.payTo && role.facilitator && role.authorizer);
  const description: PaymentDescription = {
    network: DEVNET,
    mint: role.mint,
    payTo: role.payTo,
    feePayer: role.facilitator,
    authorizer: role.authorizer,
    protocolFeeBps: PROTOCOL_FEE.bps,
    treasury: PROTOCOL_FEE.treasury,
  };
  const ledger = newLedger(Date.now());
  const hints = {
    recentBlockhash: (await generateKeyPairSigner()).address,
    lastValidBlockHeight: '500000000',
    recentSlot: '400000000',
  };
  const chain = ledgerChain(
    ledger,
    createUptoVerifier(address(description.feePayer), async () =>
      BigInt(hints.recentSlot),
    ),
    { failUpstream: false },
  );
  const authorizations: PaymentAuthorization[] = [];
  let unavailable = false;
  let wrongShares = false;
  let claimsBlocked = false;
  let last:
    | {
        authorization: PaymentAuthorization;
        settlement: PaymentSettlement;
        charged: string;
      }
    | undefined;
  let current: ReturnType<typeof createUptoPaymentClient> | undefined;
  let currentOpen = false;
  let deposits = 0;
  let settlements = 0;
  const deposit = chain.deposit;
  chain.deposit = async (...args) => {
    const result = await deposit(...args);
    deposits++;
    return result;
  };
  const claim = chain.claim;
  chain.claim = async (...args) => {
    if (claimsBlocked) throw new Error('Synthetic claim unavailable');
    const before = ledger.transactions.size;
    const result = await claim(...args);
    settlements += ledger.transactions.size - before;
    return result;
  };
  async function recover(check: (client: PaymentClient) => Promise<void>) {
    if (currentOpen && current) return check(current);
    const runtime = await services.buyer();
    try {
      await check(runtime.client);
    } finally {
      await runtime.close();
    }
  }
  const services = {
    ledger,
    wrongShares(value: boolean) {
      wrongShares = value;
    },
    blockClaims(value: boolean) {
      claimsBlocked = value;
    },
    deposits: () => deposits,
    settlements: () => settlements,
    authorizations: () => authorizations.length,
    latestAuthorization: () => authorizations.at(-1),
    unavailable(value: boolean) {
      unavailable = value;
    },
    async seller() {
      const file = await openUptoFileLedger({
        paths: paymentPathsIn(process.env, P2P_ROLES.SELLER),
        now: Date.now,
        retentionMs: LEDGER_FILE.minRetentionMs,
        maxChannels: UPTO_SELLER.maxChannels,
      });
      try {
        const seller = createUptoSeller({
          chain,
          store: file.channels,
          now: Date.now,
          own: uptoSellerTerms(description, UPTO_CHANNEL_SETTINGS),
        });
        return {
          server: createUptoPaymentServer({
            description,
            settings: UPTO_CHANNEL_SETTINGS,
            seller,
          }),
          recover: async () => {
            await seller.recover();
          },
          close: () => file.close(),
        };
      } catch (error) {
        await file.close();
        throw error;
      }
    },
    async buyer() {
      const journal = await openUptoBuyerJournal({
        paths: buyerJournalPathsIn(process.env),
        now: Date.now,
      });
      try {
        const client = createUptoPaymentClient({
          payer: await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER),
          policy: {
            network: DEVNET,
            mint: role.mint,
            protocolFeeBps: PROTOCOL_FEE.bps,
            treasury: PROTOCOL_FEE.treasury,
            maxAtomic: PAID_ACCEPTANCE.maxAtomic,
          },
          settings: UPTO_CHANNEL_SETTINGS,
          hints: async () => hints,
          journal,
          confirm: async (settlement) => {
            if (unavailable) throw new Error('Synthetic unavailable ledger');
            const found = ledger.transactions.get(settlement.transaction);
            return found && wrongShares
              ? { ...found, feeAtomic: String(BigInt(found.feeAtomic) + 1n) }
              : found;
          },
          now: Date.now,
        });
        current = client;
        currentOpen = true;
        return {
          client: {
            ...client,
            async authorize(terms: Parameters<typeof client.authorize>[0]) {
              const authorization = await client.authorize(terms);
              authorizations.push(authorization);
              return authorization;
            },
            async checkReceipt(
              authorization: PaymentAuthorization,
              settlement: PaymentSettlement,
              charged: string,
            ) {
              last = { authorization, settlement, charged };
              await client.checkReceipt(authorization, settlement, charged);
            },
          },
          close: async () => {
            currentOpen = false;
            await journal.close();
          },
        };
      } catch (error) {
        await journal.close();
        throw error;
      }
    },
    async confirmRecovered(expected: string, channelId: string) {
      assert.ok(current);
      const authorization = authorizations.find(
        (item) => item.channelId === channelId,
      );
      const found = [...ledger.transactions].find(
        ([, item]) => item.channelId === channelId,
      );
      assert.ok(authorization && found);
      await recover((client) =>
        client.checkReceipt(
          authorization,
          { ...found[1], transaction: found[0] },
          expected,
        ),
      );
    },
    async confirmLast() {
      assert.ok(current && last);
      const held = last;
      await recover((client) =>
        client.checkReceipt(held.authorization, held.settlement, held.charged),
      );
    },
    async states() {
      assert.ok(current);
      return current.reconcile();
    },
    uniqueChannels: () => new Set(authorizations.map((a) => a.channelId)).size,
  };
  return services;
}
export type PaidAcceptancePayments = Awaited<
  ReturnType<typeof paidAcceptancePayments>
>;
