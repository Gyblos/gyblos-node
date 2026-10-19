import type { KeyPairSigner } from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { toFacilitatorSvmSigner } from '@x402/svm';
import {
  InMemoryPaymentChannelStorage,
  UptoSvmScheme,
} from '@x402/svm/upto/facilitator';
import express from 'express';

import {
  CLEANUP,
  DIAGNOSTIC_LIMITS,
  HTTP_STATUS,
  ROUTES,
} from '@gyblos/config';
import { DEVNET, MAX_ATOMIC } from '@gyblos/payments-x402/constants';

export interface SettlementEvent {
  phase: string;
  channelId: string;
  amount: string;
  success: boolean;
  transaction?: string;
  errorReason?: string;
  errorMessage?: string;
}

export function createFacilitator(
  signer: KeyPairSigner,
  rpcUrl: string,
  allowed: { buyer: string; mint: string; payTo: string; authorizer: string },
  runId?: string,
) {
  const events: SettlementEvent[] = [];
  const verifications: {
    channelId: string;
    isValid: boolean;
    invalidReason?: string;
  }[] = [];
  const scheme = new UptoSvmScheme(
    toFacilitatorSvmSigner(signer, { defaultRpcUrl: rpcUrl }),
    {
      channelStorage: new InMemoryPaymentChannelStorage(),
      maxChannelLifetimeSecs: CLEANUP.maxChannelLifetimeSeconds,
      maxPriorityFeeMicroLamports: CLEANUP.maxPriorityFeeMicroLamports,
    },
  );
  const facilitator = new x402Facilitator().register(DEVNET, scheme);
  const cleanup = scheme.createRentCleanupManager(DEVNET);
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.get(ROUTES.health, (_req, res) => {
    res.json({ runId: runId ?? null });
  });
  app.get(ROUTES.supported, (_req, res) => {
    res.json(facilitator.getSupported());
  });
  app.get(ROUTES.events, (_req, res) => {
    res.json(events);
  });
  app.get(ROUTES.verifications, (_req, res) => {
    res.json(verifications);
  });
  for (const operation of ['verify', 'settle'] as const) {
    app.post(`/${operation}`, async (req, res) => {
      const payload = req.body?.paymentPayload as PaymentPayload | undefined;
      const requirements = req.body?.paymentRequirements as
        PaymentRequirements | undefined;
      if (
        !payload ||
        !requirements ||
        requirements.network !== DEVNET ||
        requirements.scheme !== 'upto' ||
        requirements.asset !== allowed.mint ||
        requirements.payTo !== allowed.payTo ||
        requirements.extra?.feePayer !== signer.address ||
        requirements.extra?.receiverAuthorizer !== allowed.authorizer ||
        !payload.payload ||
        typeof payload.payload !== 'object' ||
        payload.payload.from !== allowed.buyer ||
        !/^\d+$/.test(requirements.amount) ||
        BigInt(requirements.amount) > BigInt(MAX_ATOMIC)
      ) {
        res
          .status(HTTP_STATUS.badRequest)
          .json({ error: 'Gate policy rejected payment.' });
        return;
      }
      try {
        if (operation === 'verify') {
          const result = await facilitator.verify(payload, requirements);
          verifications.push({
            channelId: String(payload.payload.channelId),
            isValid: result.isValid,
            invalidReason: result.invalidReason,
          });
          res.json(result);
        } else {
          const result = await facilitator.settle(payload, requirements);
          events.push({
            phase: String(payload.payload.type),
            channelId: String(payload.payload.channelId),
            amount: requirements.amount,
            success: result.success,
            transaction: result.transaction,
            errorReason: result.errorReason,
            errorMessage: result.errorMessage
              ?.replace(/https?:\/\/\S+/g, '[RPC URL]')
              .slice(0, DIAGNOSTIC_LIMITS.recordedErrorCharacters),
          });
          res.json(result);
        }
      } catch {
        // Never log signed payloads, keys, or RPC URLs.
        res.status(HTTP_STATUS.internalServerError).json({
          error: `${operation} failed; payment state may be unknown. Reconcile on-chain.`,
        });
      }
    });
  }
  return { app, cleanup, events, verifications };
}
