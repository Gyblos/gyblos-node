// Loopback x402 "exact" seller and an audited public facilitator client that records each verify/settle
// call; rejects replayed authorizations without retaining the signed payload.
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
  DIAGNOSTIC_LIMITS,
  HTTP_STATUS,
  PAYMENT_LIMITS,
  ROUTES,
  TIMEOUTS,
} from '@gyblos/config';
import {
  DEVNET,
  DEVNET_USDC,
  PUBLIC_CALL_OPERATIONS,
  type PublicCallOperation,
} from '@gyblos/payments-x402/constants';
import { UNKNOWN_ERROR_NAME } from '@gyblos/runtime/constants';
import { requireLoopbackHost } from '@gyblos/runtime/loopback-host';

import {
  EXACT_PRICE,
  GATE_ROUTES,
  PUBLIC_CALL_OUTCOMES,
} from '../constants.js';
import { exactAuthorizationId } from './authorization-id.js';
import { assertExactSupport, validateExactTerms } from './index.js';
import type { PublicCall } from './types.js';

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
        operation: PUBLIC_CALL_OPERATIONS.VERIFY,
        url: this.url,
        outcome: result.isValid
          ? PUBLIC_CALL_OUTCOMES.SUCCESS
          : PUBLIC_CALL_OUTCOMES.REJECTED,
        reason: result.invalidReason,
        payer: result.payer,
      });
      return result;
    } catch (error) {
      this.recordError(PUBLIC_CALL_OPERATIONS.VERIFY, error);
      throw error;
    }
  }
  override async settle(payload: PaymentPayload, terms: PaymentRequirements) {
    try {
      const result = await super.settle(payload, terms);
      this.calls.push({
        operation: PUBLIC_CALL_OPERATIONS.SETTLE,
        url: this.url,
        outcome: result.success
          ? PUBLIC_CALL_OUTCOMES.SUCCESS
          : PUBLIC_CALL_OUTCOMES.UNCERTAIN,
        transaction: result.transaction,
        reason: result.errorReason,
        payer: result.payer,
      });
      return result;
    } catch (error) {
      this.recordError(PUBLIC_CALL_OPERATIONS.SETTLE, error);
      throw error;
    }
  }
  private recordError(operation: PublicCallOperation, error: unknown) {
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
        operation === PUBLIC_CALL_OPERATIONS.VERIFY &&
        reason &&
        !errorDetails.transaction &&
        !/pending|timeout|unknown/i.test(reason)
          ? PUBLIC_CALL_OUTCOMES.REJECTED
          : PUBLIC_CALL_OUTCOMES.UNCERTAIN,
      reason: reason ?? errorDetails.name ?? UNKNOWN_ERROR_NAME,
      transaction: errorDetails.transaction,
      message: (errorDetails.invalidMessage ?? errorDetails.errorMessage)
        ?.replace(/https?:\/\/\S+/g, '[URL]')
        .slice(0, DIAGNOSTIC_LIMITS.publicErrorMessageCharacters),
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
  app.use(requireLoopbackHost);
  let handlerCalls = 0;
  const authorizations = new Set<string>();
  app.get(ROUTES.health, (_request, response) => {
    response.json({ handlerCalls, fixture: true, scheme: 'exact' });
  });
  // Process-scoped replay guard. Never retain or log the signed payload itself.
  app.use(GATE_ROUTES.exact, async (request, response, next) => {
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
          last?.outcome === PUBLIC_CALL_OUTCOMES.UNCERTAIN
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
        [GATE_ROUTES.exactDefinition]: {
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
  app.get(GATE_ROUTES.exact, (_request, response) => {
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
