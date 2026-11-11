// Independent parent-owned simulated ledger and real private SDK journals; no RPC or transaction submission.
import assert from 'node:assert/strict';

import type { KeyPairSigner } from '@solana/kit';
import { isBatchFacilitatorPayload, isBatchPayload } from '@x402/svm';
import { signBatchVoucher } from '@x402/svm/batch-settlement/client';

import {
  batchPoolPathsIn,
  batchSessionPathsIn,
  DEVNET,
  PROTOCOL_FEE,
} from '@gyblos/config';
import { roleSigner, type RoleConfig } from '@gyblos/node/roles';
import type { SellerPayments } from '@gyblos/node/seller-paid';
import type {
  BuyerSessionBackend,
  SellerSessionBackend,
} from '@gyblos/node/session-backend';
import {
  createBatchBuyer,
  createBatchSeller,
  inspectBatchSession,
  openBatchBuyerPool,
} from '@gyblos/payments-upto/batch-session';
import { matchBatchTerms } from '@gyblos/protocol/batch-channel';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { controlObject } from '@gyblos/protocol/control-validation';
import type { SessionSettlement } from '@gyblos/protocol/payment-session';

import {
  HTTP_MULTI_METHODS,
  type HttpMultiMethod,
} from './http-multiseller-constants';
import type { HttpMultiIpc } from './http-multiseller-ipc';

export function httpMultiLedger(payer: KeyPairSigner) {
  const opened = new Map<string, { seller: string; deposit: bigint }>();
  const settled = new Map<string, SessionSettlement>();
  const calls: { seller: string; type: string; channel: string }[] = [];
  const observe = async (id: string) => settled.get(id);
  return {
    calls,
    settled,
    observe,
    async handle(method: HttpMultiMethod, params: unknown) {
      if (method === HTTP_MULTI_METHODS.OBSERVE) {
        assert.equal(typeof params, 'string');
        return observe(String(params));
      }
      if (method === HTTP_MULTI_METHODS.OPENED) {
        assert.equal(typeof params, 'string');
        return opened.has(String(params));
      }
      const row = controlObject(params, ['terms', 'payload']);
      const terms = matchBatchTerms(row.terms, row.terms);
      assert.equal(terms.buyer, payer.address);
      const payload = row.payload;
      assert.ok(
        (isBatchPayload(payload) || isBatchFacilitatorPayload(payload)) &&
          'voucher' in payload &&
          payload.voucher,
      );
      const voucher = payload.voucher;
      const expected = await signBatchVoucher(payer, {
        channelId: voucher.channelId,
        maxClaimableAmount: BigInt(voucher.maxClaimableAmount),
        expiresAt: voucher.expiresAt,
      });
      const valid = voucher.signature === expected.signature;
      if (method === HTTP_MULTI_METHODS.VERIFY)
        return { isValid: valid, payer: terms.buyer };
      assert.equal(method, HTTP_MULTI_METHODS.SETTLE);
      assert.ok(valid);
      const id = voucher.channelId;
      if (payload.type === 'deposit') {
        assert.equal(voucher.maxClaimableAmount, '0');
        assert.ok(!opened.has(id));
        opened.set(id, {
          seller: terms.sellerNodeId,
          deposit: BigInt(terms.depositAtomic),
        });
      } else {
        const original = opened.get(id);
        assert.ok(original);
        assert.equal(original.seller, terms.sellerNodeId);
        assert.ok(
          BigInt(voucher.maxClaimableAmount) <= original.deposit &&
            !settled.has(id),
        );
        settled.set(id, {
          channelId: id,
          chargedAtomic: voucher.maxClaimableAmount,
          refundedAtomic: String(
            original.deposit - BigInt(voucher.maxClaimableAmount),
          ),
          transaction: `synthetic${id}`,
        });
      }
      calls.push({
        seller: terms.sellerNodeId,
        type: payload.type,
        channel: id,
      });
      return {
        success: true,
        transaction:
          payload.type === 'deposit' ? `syntheticOpen${id}` : `synthetic${id}`,
        network: DEVNET,
        payer: terms.buyer,
      };
    },
    pool: async (_role: unknown, totalDepositAtomic: string) =>
      openBatchBuyerPool({
        paths: batchPoolPathsIn(process.env),
        totalDepositAtomic,
        now: Date.now,
        backend: async (paths): Promise<BuyerSessionBackend> => ({
          inspect: () => inspectBatchSession(paths),
          observe,
          create: (terms) =>
            createBatchBuyer({
              terms,
              paths,
              payer,
              now: Date.now,
              hints: async () => ({
                blockhash: '11111111111111111111111111111111',
                lastValidBlockHeight: '1000',
                slot: '1',
              }),
            }),
        }),
      }),
  };
}
export async function httpMultiSellerPayments(
  role: RoleConfig,
  buyerNodeId: string,
  ipc: HttpMultiIpc,
  ack: () => boolean,
): Promise<SellerPayments> {
  assert.ok(
    role.role === P2P_ROLES.SELLER &&
      role.payTo &&
      role.facilitator &&
      role.authorizer,
  );
  const paths = batchSessionPathsIn(process.env, P2P_ROLES.SELLER);
  const authorizer = await roleSigner(P2P_ROLES.SELLER, 'authorizer');
  const backend: SellerSessionBackend = {
    inspect: () => inspectBatchSession(paths),
    async create(terms) {
      const service = await createBatchSeller({
        terms,
        paths,
        authorizer,
        now: Date.now,
        observeOpening: async (opening) =>
          (await ipc.call(
            HTTP_MULTI_METHODS.OPENED,
            opening.voucher!.channelId,
          )) === true,
        observe: async (id) => {
          const result = await ipc.call(HTTP_MULTI_METHODS.OBSERVE, id);
          if (result === null) return undefined;
          const value = controlObject(result, [
            'channelId',
            'chargedAtomic',
            'refundedAtomic',
            'transaction',
          ]);
          assert.equal(typeof value.channelId, 'string');
          assert.equal(typeof value.chargedAtomic, 'string');
          assert.equal(typeof value.refundedAtomic, 'string');
          assert.equal(typeof value.transaction, 'string');
          return {
            channelId: String(value.channelId),
            chargedAtomic: String(value.chargedAtomic),
            refundedAtomic: String(value.refundedAtomic),
            transaction: String(value.transaction),
          };
        },
        closing: async () => false,
        facilitator: async () => ({
          verify: async (payment) => {
            const value = controlObject(
              await ipc.call(HTTP_MULTI_METHODS.VERIFY, {
                terms,
                payload: payment.payload,
              }),
              ['isValid', 'payer'],
            );
            assert.equal(typeof value.payer, 'string');
            return {
              isValid: value.isValid === true,
              payer: String(value.payer),
            };
          },
          settle: async (payment) => {
            const value = controlObject(
              await ipc.call(HTTP_MULTI_METHODS.SETTLE, {
                terms,
                payload: payment.payload,
              }),
              ['success', 'transaction', 'network', 'payer'],
            );
            assert.equal(value.network, DEVNET);
            assert.equal(typeof value.transaction, 'string');
            return {
              success: value.success === true,
              transaction: String(value.transaction),
              network: DEVNET,
              payer: terms.buyer,
            };
          },
        }),
      });
      return {
        ...service,
        accept: async (...args) => {
          await service.accept(...args);
          if (ack()) throw new Error('Synthetic acknowledgment unavailable');
        },
      };
    },
  };
  return {
    server: {
      describe: async () => ({
        network: DEVNET,
        mint: role.mint,
        payTo: role.payTo!,
        feePayer: role.facilitator!,
        authorizer: role.authorizer!,
        protocolFeeBps: PROTOCOL_FEE.bps,
        treasury: PROTOCOL_FEE.treasury,
      }),
      admit: async () => assert.fail('legacy payment path forbidden'),
      settle: async () => assert.fail('legacy settlement forbidden'),
    },
    sessions: { buyerNodeId, backend },
    close: async () => {},
  };
}
