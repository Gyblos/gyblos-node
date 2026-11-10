// Real private batch journals and SDK vouchers over a synthetic ledger; no RPC or real transaction sends.
import assert from 'node:assert/strict';

import { signBatchVoucher } from '@x402/svm/batch-settlement/client';

import { batchSessionPathsIn, DEVNET, PROTOCOL_FEE } from '@gyblos/config';
import { roleSigner } from '@gyblos/node/roles';
import type { SellerPayments } from '@gyblos/node/seller-paid';
import type {
  BuyerSessionBackend,
  SellerSessionBackend,
} from '@gyblos/node/session-backend';
import * as sessions from '@gyblos/payments-upto/batch-session';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type {
  PaymentSessionTerms,
  SessionSettlement,
} from '@gyblos/protocol/payment-session';

import type { paidAcceptanceRoles } from './paid-acceptance-config';

export async function sessionProductPayments(
  roles: Awaited<ReturnType<typeof paidAcceptanceRoles>>,
) {
  assert.equal(roles.seller.role, P2P_ROLES.SELLER);
  const payer = await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER);
  const authorizer = await roleSigner(P2P_ROLES.SELLER, 'authorizer');
  const calls: string[] = [];
  const opened = new Set<string>();
  const settled = new Map<string, SessionSettlement>();
  let offset = 0;
  let buyerCreates = 0;
  let sellerCreates = 0;
  let lostAcknowledgment = false;
  let approvals = 0;
  const now = () => Date.now() + offset;
  const paths = (role: typeof P2P_ROLES.BUYER | typeof P2P_ROLES.SELLER) =>
    batchSessionPathsIn(process.env, role);
  const inspect = (role: typeof P2P_ROLES.BUYER | typeof P2P_ROLES.SELLER) =>
    'inspectBatchSession' in sessions
      ? sessions.inspectBatchSession(paths(role))
      : Promise.resolve(undefined);
  const observe = async (id: string) => settled.get(id);
  const buyer: BuyerSessionBackend = {
    inspect: () => inspect(P2P_ROLES.BUYER),
    observe,
    create: async (terms) => {
      buyerCreates++;
      return sessions.createBatchBuyer({
        terms,
        paths: paths(P2P_ROLES.BUYER),
        payer,
        now,
        hints: async () => ({
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: '1000',
          slot: '1',
        }),
      });
    },
  };
  const seller: SellerSessionBackend = {
    inspect: () => inspect(P2P_ROLES.SELLER),
    async create(terms: PaymentSessionTerms) {
      sellerCreates++;
      const financial = await sessions.createBatchSeller({
        terms,
        authorizer,
        paths: paths(P2P_ROLES.SELLER),
        now,
        pollMs: 20,
        observe,
        observeOpening: async (opening) =>
          opened.has(opening.voucher!.channelId),
        closing: async () => false,
        facilitator: async () => ({
          async verify(payment) {
            const raw = payment.payload.voucher;
            assert.ok(raw && typeof raw === 'object');
            const voucher = raw as {
              channelId: string;
              maxClaimableAmount: string;
              expiresAt: number;
              signature: string;
            };
            const expected = await signBatchVoucher(payer, {
              channelId: voucher.channelId,
              maxClaimableAmount: BigInt(voucher.maxClaimableAmount),
              expiresAt: voucher.expiresAt,
            });
            return {
              isValid: voucher.signature === expected.signature,
              payer: terms.buyer,
            };
          },
          async settle(payment) {
            calls.push(String(payment.payload.type));
            const raw = payment.payload.voucher as {
              channelId: string;
              maxClaimableAmount: string;
            };
            if (payment.payload.type === 'deposit') opened.add(raw.channelId);
            else
              settled.set(raw.channelId, {
                channelId: raw.channelId,
                chargedAtomic: raw.maxClaimableAmount,
                refundedAtomic: String(
                  BigInt(terms.depositAtomic) - BigInt(raw.maxClaimableAmount),
                ),
                transaction: 'synthetic-confirmed-close',
              });
            return {
              success: true,
              transaction:
                payment.payload.type === 'deposit'
                  ? 'synthetic-open'
                  : 'synthetic-confirmed-close',
              network: DEVNET,
              payer: terms.buyer,
            };
          },
        }),
      });
      return {
        ...financial,
        async accept(...args) {
          await financial.accept(...args);
          approvals++;
          if (lostAcknowledgment) {
            lostAcknowledgment = false;
            throw new Error('Synthetic acknowledgment lost');
          }
        },
      };
    },
  };
  return {
    buyer: async () => buyer,
    seller: async (): Promise<SellerPayments> => ({
      server: {
        describe: async () => ({
          network: DEVNET,
          mint: roles.seller.mint,
          payTo: roles.seller.payTo!,
          feePayer: roles.seller.facilitator!,
          authorizer: roles.seller.authorizer!,
          protocolFeeBps: PROTOCOL_FEE.bps,
          treasury: PROTOCOL_FEE.treasury,
        }),
        admit: async () => assert.fail('legacy payment path must not run'),
        settle: async () => assert.fail('legacy settlement must not run'),
      },
      sessions: { buyerNodeId: roles.buyer.nodeId, backend: seller },
      close: async () => {},
    }),
    calls,
    settled,
    approvals: () => approvals,
    loseAcknowledgment: () => {
      lostAcknowledgment = true;
    },
    buyerCreates: () => buyerCreates,
    sellerCreates: () => sellerCreates,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}
