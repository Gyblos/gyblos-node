import type { KeyPairSigner } from '@solana/kit';
import { HTTPFacilitatorClient } from '@x402/core/server';
import {
  paymentMiddleware,
  setSettlementOverrides,
  x402ResourceServer,
} from '@x402/express';
import { UptoSvmScheme } from '@x402/svm/upto/server';
import express from 'express';

import { PAYMENT_LIMITS, ROUTES, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import {
  ACTUAL_ATOMIC,
  DEVNET,
  MAX_ATOMIC,
} from '@gyblos/payments-x402/constants';
import { requireLoopbackHost } from '@gyblos/runtime/loopback-host';

export async function createGateSeller(options: {
  rpcUrl: string;
  facilitatorUrl: string;
  mint: string;
  payTo: string;
  authorizer: KeyPairSigner;
  runId?: string;
}) {
  const resource = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: options.facilitatorUrl }),
  ).register(
    DEVNET,
    new UptoSvmScheme({
      receiverAuthorizerSigner: options.authorizer,
      rpcUrl: options.rpcUrl,
      withdrawDelay: PAYMENT_LIMITS.withdrawDelay,
    }),
  );
  await resource.initialize();
  const app = express();
  app.use(requireLoopbackHost);
  let handlerCalls = 0;
  app.get(ROUTES.health, (_request, response) => {
    response.json({
      gateFixture: true,
      handlerCalls,
      runId: options.runId ?? null,
    });
  });
  app.use(
    paymentMiddleware(
      {
        [ROUTES.fixedDefinition]: {
          accepts: [
            {
              scheme: 'upto',
              network: DEVNET,
              payTo: options.payTo,
              price: { asset: options.mint, amount: MAX_ATOMIC },
              maxTimeoutSeconds: PAYMENT_LIMITS.withdrawDelay,
              extra: { tokenProgram: TOKEN_PROGRAM_ADDRESS },
            },
          ],
          description: 'Devnet protocol gate: fixed resource, not inference',
          mimeType: 'application/json',
        },
      },
      resource,
      undefined,
      undefined,
      false,
    ),
  );
  app.get(ROUTES.fixed, (_request, response) => {
    handlerCalls++;
    setSettlementOverrides(response, { amount: ACTUAL_ATOMIC });
    response.json({
      gateFixture: true,
      resource: 'x402 devnet gate resource',
      usage: {
        authorizedMaxAtomic: MAX_ATOMIC,
        actualChargedAtomic: ACTUAL_ATOMIC,
      },
    });
  });
  return { app, resource };
}
