import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { KeyPairSigner } from '@solana/kit';
import {
  decodePaymentSignatureHeader,
  type DynamicPrice,
} from '@x402/core/http';
import { HTTPFacilitatorClient } from '@x402/core/server';
import {
  paymentMiddleware,
  setSettlementOverrides,
  x402ResourceServer,
} from '@x402/express';
import { UptoSvmScheme } from '@x402/svm/upto/server';
import express from 'express';

import {
  charge,
  OFFER_ID,
  type TokenCounts,
} from '../../../packages/application/src/metering.js';
import {
  createOllama,
  MODEL,
  type ModelTokenizer,
} from '../../../packages/inference-ollama/src/index.js';
import {
  DEVNET,
  MAX_ATOMIC,
} from '../../../packages/payments-x402/src/constants.js';
import { verifyInferenceDeposit } from '../../../packages/payments-x402/src/inference-deposit.js';

export interface InferenceRequest {
  requestId: string;
  prompt: string;
  maxTokens: number;
}
export function parseInferenceRequest(value: unknown): InferenceRequest {
  const body = value as Partial<InferenceRequest> | null;
  if (
    !body ||
    typeof body.requestId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(body.requestId) ||
    typeof body.prompt !== 'string' ||
    !Number.isSafeInteger(body.maxTokens) ||
    body.maxTokens! < 32 ||
    body.maxTokens! > 128
  )
    throw new Error('Invalid bounded inference request.');
  return {
    requestId: body.requestId,
    prompt: body.prompt,
    maxTokens: body.maxTokens!,
  };
}
export function inferenceCeiling(
  input: InferenceRequest,
  tokenizer: ModelTokenizer,
): string {
  // Headroom is authorized up front, never evidence of actual usage.
  const inputTokens = tokenizer.input(input.prompt);
  if (inputTokens + input.maxTokens > 2048) {
    throw new Error('Request exceeds the pinned context window.');
  }
  const ceiling = 2n * charge({ input: inputTokens, output: input.maxTokens });
  if (ceiling > BigInt(MAX_ATOMIC))
    throw new Error('Inference ceiling exceeds gate policy.');
  return ceiling.toString();
}

export async function createInferenceSeller(options: {
  rpcUrl: string;
  facilitatorUrl: string;
  feePayer: string;
  ollamaUrl: string;
  mint: string;
  payTo: string;
  authorizer: KeyPairSigner;
  tokenizer: ModelTokenizer;
  beforeInference: (requestId: string, channelId: string) => Promise<void>;
  billingOverride?: (
    requestId: string,
    usage: Readonly<TokenCounts>,
  ) => TokenCounts;
  onFragment?: (requestId: string) => Promise<void>;
}) {
  const engine = createOllama(options.ollamaUrl);
  await engine.assertModel();
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
  app.use(express.json({ limit: '8kb' }));
  app.post('/v1/chat/completions', (req, res, next) => {
    try {
      inferenceCeiling(parseInferenceRequest(req.body), options.tokenizer);
      next();
    } catch {
      res.status(400).json({ error: 'Invalid bounded inference request.' });
    }
  });
  const price: DynamicPrice = (context) => ({
    asset: options.mint,
    amount: inferenceCeiling(
      parseInferenceRequest(context.adapter.getBody?.()),
      options.tokenizer,
    ),
  });
  app.use(
    paymentMiddleware(
      {
        'POST /v1/chat/completions': {
          accepts: [
            {
              scheme: 'upto',
              network: DEVNET,
              payTo: options.payTo,
              price,
              maxTimeoutSeconds: 120,
              extra: { tokenProgram: TOKEN_PROGRAM_ADDRESS },
            },
          ],
          description: 'Local Qwen inference, metered upto settlement',
          mimeType: 'application/json',
        },
      },
      resource,
      undefined,
      undefined,
      false,
    ),
  );
  app.post('/v1/chat/completions', async (req, res) => {
    const input = parseInferenceRequest(req.body);
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      if (req.aborted || res.destroyed) abort();
      controller.signal.throwIfAborted();
      const payload = decodePaymentSignatureHeader(
        req.get('PAYMENT-SIGNATURE')!,
      );
      const channelId = payload.payload.channelId;
      if (typeof channelId !== 'string') throw new Error('Missing channel.');
      if (typeof payload.payload.from !== 'string')
        throw new Error('Missing buyer.');
      await verifyInferenceDeposit({
        rpcUrl: options.rpcUrl,
        channelId,
        buyer: payload.payload.from,
        feePayer: options.feePayer,
        authorizer: options.authorizer.address,
        mint: options.mint,
        ceiling: inferenceCeiling(input, options.tokenizer),
      });
      await options.beforeInference(input.requestId, channelId);
      controller.signal.throwIfAborted();
      const result = await engine.generate({
        prompt: input.prompt,
        maxTokens: input.maxTokens,
        signal: controller.signal,
        onFragment: () =>
          options.onFragment?.(input.requestId) ?? Promise.resolve(),
      });
      controller.signal.throwIfAborted();
      const engineTokens = {
        input: result.usage.prompt_eval_count,
        output: result.usage.eval_count,
      };
      const billedTokens =
        options.billingOverride?.(
          input.requestId,
          Object.freeze({ ...engineTokens }),
        ) ?? engineTokens;
      const actual = charge(billedTokens);
      if (actual > BigInt(inferenceCeiling(input, options.tokenizer)))
        throw new Error('Usage exceeds authorized ceiling.');
      setSettlementOverrides(res, { amount: actual.toString() });
      res.json({
        requestId: input.requestId,
        offer: OFFER_ID,
        model: MODEL.name,
        digest: MODEL.digest,
        content: result.text,
        usage: result.usage,
        billedTokens,
        done: result.done,
        doneReason: result.doneReason,
      });
    } catch {
      // Explicitly end the Express 4 response so x402 cancels and settles zero.
      setSettlementOverrides(res, { amount: '0' });
      res.status(502).json({
        requestId: input.requestId,
        error:
          'Local inference failed; inspect confirmed settlement for refund.',
      });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  });
  return { app };
}
