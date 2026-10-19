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
  HTTP_LIMITS,
  HTTP_STATUS,
  ROUTES,
} from '@gyblos/config';
import {
  DEVNET,
  MAX_ATOMIC,
  PUBLIC_CALL_OPERATIONS,
} from '@gyblos/payments-x402/constants';

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
  app.use(express.json({ limit: HTTP_LIMITS.facilitatorBody }));
  app.get(ROUTES.health, (_request, response) => {
    response.json({ runId: runId ?? null });
  });
  app.get(ROUTES.supported, (_request, response) => {
    response.json(facilitator.getSupported());
  });
  app.get(ROUTES.events, (_request, response) => {
    response.json(events);
  });
  app.get(ROUTES.verifications, (_request, response) => {
    response.json(verifications);
  });
  for (const operation of [
    PUBLIC_CALL_OPERATIONS.VERIFY,
    PUBLIC_CALL_OPERATIONS.SETTLE,
  ]) {
    app.post(`/${operation}`, async (request, response) => {
      const payload = request.body?.paymentPayload as
        PaymentPayload | undefined;
      const requirements = request.body?.paymentRequirements as
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
        response
          .status(HTTP_STATUS.badRequest)
          .json({ error: 'Gate policy rejected payment.' });
        return;
      }
      try {
        if (operation === PUBLIC_CALL_OPERATIONS.VERIFY) {
          const result = await facilitator.verify(payload, requirements);
          verifications.push({
            channelId: String(payload.payload.channelId),
            isValid: result.isValid,
            invalidReason: result.invalidReason,
          });
          response.json(result);
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
          response.json(result);
        }
      } catch {
        // Never log signed payloads, keys, or RPC URLs.
        response.status(HTTP_STATUS.internalServerError).json({
          error: `${operation} failed; payment state may be unknown. Reconcile on-chain.`,
        });
      }
    });
  }
  return { app, cleanup, events, verifications };
}
