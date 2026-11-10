// Synthetic session peers and chain observations. No real RPC, wallets, model or payment operations.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPairSigner } from '@solana/kit';
import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';
import { signBatchVoucher } from '@x402/svm/batch-settlement/client';

import { PROTOCOL_FEE } from '@gyblos/config';
import { batchSessionPathsIn } from '@gyblos/config/home';
import {
  createBatchBuyer,
  createBatchSeller,
  type BatchSellerOptions,
} from '@gyblos/payments-upto/batch-session';
import type {
  PaymentSessionTerms,
  SessionRequest,
  SessionSettlement,
} from '@gyblos/protocol/payment-session';

export async function sessionRig(nodes?: {
  buyerNodeId: string;
  sellerNodeId: string;
  treasury?: string;
  transaction?: string;
  payer?: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  mint?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'gyb-batch-session-test-'));
  let now = 1_800_000_000_000;
  const payer = nodes?.payer ?? (await generateKeyPairSigner());
  const authorizer = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const treasury = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const terms: PaymentSessionTerms = {
    buyer: payer.address,
    buyerNodeId: nodes?.buyerNodeId ?? '12'.repeat(32),
    owner: seller.address,
    sellerNodeId: nodes?.sellerNodeId ?? '34'.repeat(32),
    network: SOLANA_TESTNET_CAIP2,
    mint: nodes?.mint ?? mint.address,
    payTo: seller.address,
    feePayer: feePayer.address,
    authorizer: authorizer.address,
    treasury: nodes?.treasury ?? treasury.address,
    protocolFeeBps: PROTOCOL_FEE.bps,
    depositAtomic: '1000',
    withdrawDelaySeconds: 900,
    expiresAt: now + 3_600_000,
  };
  const buyerOptions = {
    terms,
    payer,
    now: () => now,
    paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer'),
    hints: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: '1000',
      slot: '1',
    }),
  };
  const calls: string[] = [];
  let confirmed = true;
  let closing = false;
  let opened = false;
  let chainSettlement: SessionSettlement | undefined;
  const sellerOptions: BatchSellerOptions = {
    terms,
    authorizer,
    now: () => now,
    paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller'),
    minSettlementAtomic: '100',
    idleMs: 1000,
    closing: async () => closing,
    observeOpening: async () => opened,
    observe: async () => (confirmed ? chainSettlement : undefined),
    facilitator: async () => ({
      async verify(payment) {
        const raw = payment.payload;
        const voucher = raw.voucher as ReturnType<
          typeof signBatchVoucher
        > extends Promise<infer T>
          ? T
          : never;
        const expected = await signBatchVoucher(payer, {
          channelId: voucher.channelId,
          maxClaimableAmount: BigInt(voucher.maxClaimableAmount),
          expiresAt: voucher.expiresAt,
        });
        return {
          isValid: expected.signature === voucher.signature,
          payer: terms.buyer,
        };
      },
      async settle(payment, requirements) {
        const raw = payment.payload;
        calls.push(String(raw.type));
        if (raw.type === 'deposit') opened = true;
        if (raw.type === 'refund' || raw.type === 'seal') {
          const voucher = raw.voucher as {
            channelId: string;
            maxClaimableAmount: string;
          };
          chainSettlement = {
            channelId: voucher.channelId,
            chargedAtomic: voucher.maxClaimableAmount,
            refundedAtomic: String(
              BigInt(terms.depositAtomic) - BigInt(voucher.maxClaimableAmount),
            ),
            transaction:
              nodes?.transaction ??
              nodes?.transaction ??
              'synthetic-confirmed-close',
          };
        }
        return {
          success: true,
          transaction:
            raw.type === 'refund'
              ? (nodes?.transaction ?? 'synthetic-confirmed-close')
              : 'synthetic-open',
          network: requirements.network,
          payer: terms.buyer,
        };
      },
    }),
  };
  const buyer = await createBatchBuyer(buyerOptions);
  let service = await createBatchSeller(sellerOptions);
  const open = async () => service.open(await buyer.open());
  const request = (index: number, maxAtomic = '200'): SessionRequest => ({
    requestId: index.toString(16).padStart(32, '0'),
    requestDigest: index.toString(16).padStart(64, '0'),
    maxAtomic,
  });
  const serve = async (index: number, amount: string, verify = amount) => {
    const pending = request(index);
    await buyer.begin(pending);
    await service.reserve(pending, terms.buyerNodeId);
    const bill = await service.finish(pending.requestId, amount);
    const voucher = await buyer.approve(bill, verify);
    await service.accept(bill, voucher, terms.buyerNodeId);
    await buyer.acknowledge(pending.requestId);
    return { bill, voucher };
  };
  return {
    root,
    owner: seller,
    terms,
    buyer,
    buyerOptions,
    sellerOptions,
    calls,
    request,
    serve,
    open,
    seller: () => service,
    async restart() {
      await service.dispose();
      service = await createBatchSeller(sellerOptions);
    },
    time: (value: number) => {
      now = value;
    },
    now: () => now,
    confirmed: (value: boolean) => {
      confirmed = value;
    },
    closing: (value: boolean) => {
      closing = value;
    },
    async dispose() {
      await buyer.dispose();
      await service.dispose();
    },
  };
}
