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

import { HTTP_STATUS, PAYMENT_LIMITS, ROUTES, TIMEOUTS } from '@gyblos/config';
import { DEVNET, DEVNET_USDC } from '@gyblos/payments-x402/constants';
import { exactAuthorizationId } from '@gyblos/payments-x402/exact/authorization-id';
import {
  assertExactSupport,
  EXACT_PRICE,
  validateExactTerms,
} from '@gyblos/payments-x402/exact/index';
import type { PublicCall } from '@gyblos/payments-x402/exact/types';

export type { PublicCall } from '@gyblos/payments-x402/exact/types';

export class AuditedPublicFacilitator extends HTTPFacilitatorClient {
  readonly calls: PublicCall[] = [];
  constructor(
    url: string,
    readonly feePayer: string,
  ) {
    super({ url, timeoutMs: TIMEOUTS.rpc });
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
    const errorDetails = error as {
      name?: string;
      invalidReason?: string;
      errorReason?: string;
      invalidMessage?: string;
      errorMessage?: string;
      transaction?: string;
    };
    const reason = errorDetails.invalidReason ?? errorDetails.errorReason;
    this.calls.push({
      operation,
      url: this.url,
      outcome:
        operation === 'verify' &&
        reason &&
        !errorDetails.transaction &&
        !/pending|timeout|unknown/i.test(reason)
          ? 'rejected'
          : 'uncertain',
      reason: reason ?? errorDetails.name ?? 'UnknownError',
      transaction: errorDetails.transaction,
      message: (errorDetails.invalidMessage ?? errorDetails.errorMessage)
        ?.replace(/https?:\/\/\S+/g, '[URL]')
        .slice(0, HTTP_STATUS.internalServerError),
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
  app.get(ROUTES.health, (_request, response) => {
    response.json({ handlerCalls, fixture: true, scheme: 'exact' });
  });
  // Process-scoped replay guard. Never retain or log the signed payload itself.
  app.use(ROUTES.exact, async (request, response, next) => {
    const header = request.header('PAYMENT-SIGNATURE');
    if (!header) {
      next();
      return;
    }
    try {
      const payload = decodePaymentSignatureHeader(header);
      if (typeof payload.payload.transaction !== 'string') {
        response
          .status(HTTP_STATUS.badRequest)
          .json({ error: 'Invalid exact transaction.' });
        return;
      }
      const authorizationId = exactAuthorizationId(payload.payload.transaction);
      if (authorizations.has(authorizationId)) {
        response.status(HTTP_STATUS.conflict).json({
          error:
            'Authorization already attempted; reconcile instead of replaying.',
        });
        return;
      }
      authorizations.add(authorizationId);
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
        response.status(HTTP_STATUS.paymentRequired).json({
          error: 'Payment rejected.',
          reason: verification.invalidReason,
        });
        return;
      }
      next();
    } catch {
      const last = options.facilitator.calls.at(-1);
      response
        .status(
          last?.outcome === 'uncertain'
            ? HTTP_STATUS.serviceUnavailable
            : HTTP_STATUS.paymentRequired,
        )
        .json({
          error: 'Payment not authorized.',
          reason: last?.reason ?? 'invalid_payment',
        });
    }
  });
  app.use(
    paymentMiddleware(
      {
        [ROUTES.exactDefinition]: {
          accepts: [
            {
              scheme: 'exact',
              network: DEVNET,
              payTo: options.payTo,
              price: { asset: DEVNET_USDC, amount: EXACT_PRICE },
              maxTimeoutSeconds: PAYMENT_LIMITS.withdrawDelay,
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
  app.get(ROUTES.exact, (_request, response) => {
    handlerCalls++;
    response.json({
      fixture: true,
      scheme: 'exact',
      fixedPriceAtomic: EXACT_PRICE,
    });
  });
  return {
    app,
    calls: options.facilitator.calls,
    handlerCalls: () => handlerCalls,
  };
}
