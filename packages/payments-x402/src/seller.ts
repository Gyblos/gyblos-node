import express from 'express';
import {
  paymentMiddleware,
  setSettlementOverrides,
  x402ResourceServer,
} from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { UptoSvmScheme } from '@x402/svm/upto/server';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { KeyPairSigner } from '@solana/kit';
import { ACTUAL_ATOMIC, DEVNET, MAX_ATOMIC } from './constants.js';

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
      withdrawDelay: 60,
    }),
  );
  await resource.initialize();
  const app = express();
  let handlerCalls = 0;
  app.get('/health', (_req, res) => {
    res.json({ gateFixture: true, handlerCalls, runId: options.runId ?? null });
  });
  app.use(
    paymentMiddleware(
      {
        'GET /api/generate': {
          accepts: [
            {
              scheme: 'upto',
              network: DEVNET,
              payTo: options.payTo,
              price: { asset: options.mint, amount: MAX_ATOMIC },
              maxTimeoutSeconds: 60,
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
  app.get('/api/generate', (_req, res) => {
    handlerCalls++;
    setSettlementOverrides(res, { amount: ACTUAL_ATOMIC });
    res.json({
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
