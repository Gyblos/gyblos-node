import { decodePaymentSignatureHeader } from '@x402/core/http';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequirements,
  SupportedResponse,
} from '@x402/core/types';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import express from 'express';

import {
  DEVNET,
  DEVNET_USDC,
} from '../../../packages/payments-x402/src/constants.js';
import { exactAuthorizationId } from '../../../packages/payments-x402/src/exact/authorization-id.js';
import {
  assertExactSupport,
  EXACT_PRICE,
  validateExactTerms,
} from '../../../packages/payments-x402/src/exact/index.js';

export interface PublicCall {
  operation: string;
  url: string;
  outcome: string;
  transaction?: string;
  reason?: string;
  message?: string;
  payer?: string;
}
export class AuditedPublicFacilitator extends HTTPFacilitatorClient {
  readonly calls: PublicCall[] = [];
  constructor(
    url: string,
    readonly feePayer: string,
  ) {
    super({ url, timeoutMs: 20_000 });
  }
  override async getSupported(): Promise<SupportedResponse> {
    const result = await super.getSupported();
    assertExactSupport(result, this.feePayer);
    return result;
  }
  override async verify(payload: PaymentPayload, terms: PaymentRequirements) {
    try {
      const result = await super.verify(payload, terms);
      this.calls.push({
        operation: 'verify',
        url: this.url,
        outcome: result.isValid ? 'success' : 'rejected',
        reason: result.invalidReason,
        payer: result.payer,
      });
      return result;
    } catch (error) {
      this.recordError('verify', error);
      throw error;
    }
  }
  override async settle(payload: PaymentPayload, terms: PaymentRequirements) {
    try {
      const result = await super.settle(payload, terms);
      this.calls.push({
        operation: 'settle',
        url: this.url,
        outcome: result.success ? 'success' : 'uncertain',
        transaction: result.transaction,
        reason: result.errorReason,
        payer: result.payer,
      });
      return result;
    } catch (error) {
      this.recordError('settle', error);
      throw error;
    }
  }
  private recordError(operation: string, error: unknown) {
    const e = error as {
      name?: string;
      invalidReason?: string;
      errorReason?: string;
      invalidMessage?: string;
      errorMessage?: string;
      transaction?: string;
    };
    const reason = e.invalidReason ?? e.errorReason;
    this.calls.push({
      operation,
      url: this.url,
      outcome:
        operation === 'verify' &&
        reason &&
        !e.transaction &&
        !/pending|timeout|unknown/i.test(reason)
          ? 'rejected'
          : 'uncertain',
      reason: reason ?? e.name ?? 'UnknownError',
      transaction: e.transaction,
      message: (e.invalidMessage ?? e.errorMessage)
        ?.replace(/https?:\/\/\S+/g, '[URL]')
        .slice(0, 500),
    });
  }
}
export async function createExactSeller(options: {
  rpcUrl: string;
  payTo: string;
  facilitator: AuditedPublicFacilitator;
}) {
  const resource = new x402ResourceServer(options.facilitator).register(
    DEVNET,
    new ExactSvmScheme({ rpcUrl: options.rpcUrl }),
  );
  await resource.initialize();
  const app = express();
  let handlerCalls = 0;
  const authorizations = new Set<string>();
  app.get('/health', (_req, res) => {
    res.json({ handlerCalls, fixture: true, scheme: 'exact' });
  });
  // Process-scoped replay guard. Never retain or log the signed payload itself.
  app.use('/api/exact', async (req, res, next) => {
    const header = req.header('PAYMENT-SIGNATURE');
    if (!header) {
      next();
      return;
    }
    try {
      const payload = decodePaymentSignatureHeader(header);
      if (typeof payload.payload.transaction !== 'string') {
        res.status(400).json({ error: 'Invalid exact transaction.' });
        return;
      }
      const id = exactAuthorizationId(payload.payload.transaction);
      if (authorizations.has(id)) {
        res.status(409).json({
          error:
            'Authorization already attempted; reconcile instead of replaying.',
        });
        return;
      }
      authorizations.add(id);
      validateExactTerms(payload.accepted, {
        payTo: options.payTo,
        feePayer: options.facilitator.feePayer,
        amount: EXACT_PRICE,
      });
      // The SDK upfront flow settles before the handler but skips /verify.
      // This explicit call exercises both public operations and rejects before fulfillment.
      const verification = await options.facilitator.verify(
        payload,
        payload.accepted,
      );
      if (!verification.isValid) {
        res.status(402).json({
          error: 'Payment rejected.',
          reason: verification.invalidReason,
        });
        return;
      }
      next();
    } catch {
      const last = options.facilitator.calls.at(-1);
      res.status(last?.outcome === 'uncertain' ? 503 : 402).json({
        error: 'Payment not authorized.',
        reason: last?.reason ?? 'invalid_payment',
      });
    }
  });
  app.use(
    paymentMiddleware(
      {
        'GET /api/exact': {
          accepts: [
            {
              scheme: 'exact',
              network: DEVNET,
              payTo: options.payTo,
              price: { asset: DEVNET_USDC, amount: EXACT_PRICE },
              maxTimeoutSeconds: 60,
              extra: { paymentFlow: 'upfront' },
            },
          ],
          description: 'Public facilitator exact interoperability fixture',
          mimeType: 'application/json',
        },
      },
      resource,
      undefined,
      undefined,
      false,
    ),
  );
  app.get('/api/exact', (_req, res) => {
    handlerCalls++;
    res.json({ fixture: true, scheme: 'exact', fixedPriceAtomic: EXACT_PRICE });
  });
  return {
    app,
    calls: options.facilitator.calls,
    handlerCalls: () => handlerCalls,
  };
}
