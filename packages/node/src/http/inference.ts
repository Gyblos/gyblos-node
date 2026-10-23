// Loopback x402 "upto" inference seller: parses bounded requests, authorizes a ceiling, generates only after
// the escrow deposit is confirmed, recounts usage and bills it; failures settle zero.
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
  DEVNET,
  HTTP_LIMITS,
  HTTP_STATUS,
  INFERENCE_REQUEST_LIMITS,
  MAX_ATOMIC,
  PAYMENT_LIMITS,
  ROUTES,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config';
import { OFFER_ID } from '@gyblos/core/constants';
import { charge, type TokenCounts } from '@gyblos/core/metering';
import { verifyInferenceDeposit } from '@gyblos/payments-x402/inference-deposit';
import {
  inferenceWireUsage,
  type Engine,
  type RecountTokenizer,
} from '@gyblos/protocol/engine';
import { requireLoopbackHost } from '@gyblos/runtime/loopback-host';

interface InferenceRequest {
  requestId: string;
  prompt: string;
  maxTokens: number;
}

function parseInferenceRequest(value: unknown): InferenceRequest {
  const body = value as Partial<InferenceRequest> | null;
  if (
    !body ||
    typeof body.requestId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(body.requestId) ||
    typeof body.prompt !== 'string' ||
    !Number.isSafeInteger(body.maxTokens) ||
    body.maxTokens! < INFERENCE_REQUEST_LIMITS.minOutputTokens ||
    body.maxTokens! > INFERENCE_REQUEST_LIMITS.maxOutputTokens
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
  tokenizer: RecountTokenizer,
  contextTokens: number,
): string {
  // Headroom is authorized up front, never evidence of actual usage.
  const inputTokens = tokenizer.input(input.prompt);
  if (inputTokens + input.maxTokens > contextTokens) {
    throw new Error('Request exceeds the pinned context window.');
  }
  const ceiling =
    PAYMENT_LIMITS.ceilingMultiplier *
    charge({ input: inputTokens, output: input.maxTokens });
  if (ceiling > BigInt(MAX_ATOMIC))
    throw new Error('Inference ceiling exceeds payment policy.');
  return ceiling.toString();
}

export async function createInferenceSeller(options: {
  rpcUrl: string;
  facilitatorUrl: string;
  feePayer: string;
  engine: Engine;
  mint: string;
  payTo: string;
  authorizer: KeyPairSigner;
  tokenizer: RecountTokenizer;
  beforeInference: (requestId: string, channelId: string) => Promise<void>;
  billingOverride?: (
    requestId: string,
    usage: Readonly<TokenCounts>,
  ) => TokenCounts;
  onFragment?: (requestId: string) => Promise<void>;
}) {
  const engine = options.engine;
  const model = await engine.describe();
  const capabilities = engine.capabilities();
  if (
    !capabilities.reportsUsage ||
    !capabilities.recountable ||
    capabilities.modelIdentity !== 'digest' ||
    !model.digest
  )
    throw new Error(
      'This PoC requires recountable usage and a declared model digest.',
    );
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
  app.use(express.json({ limit: HTTP_LIMITS.requestBody }));
  app.post(ROUTES.inference, (request, response, next) => {
    try {
      inferenceCeiling(
        parseInferenceRequest(request.body),
        options.tokenizer,
        model.contextTokens,
      );
      next();
    } catch {
      response
        .status(HTTP_STATUS.badRequest)
        .json({ error: 'Invalid bounded inference request.' });
    }
  });
  const price: DynamicPrice = (context) => ({
    asset: options.mint,
    amount: inferenceCeiling(
      parseInferenceRequest(context.adapter.getBody?.()),
      options.tokenizer,
      model.contextTokens,
    ),
  });
  app.use(
    paymentMiddleware(
      {
        [ROUTES.inferenceDefinition]: {
          accepts: [
            {
              scheme: 'upto',
              network: DEVNET,
              payTo: options.payTo,
              price,
              maxTimeoutSeconds: PAYMENT_LIMITS.maxTimeoutSeconds,
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
  app.post(ROUTES.inference, async (request, response) => {
    const input = parseInferenceRequest(request.body);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      if (request.aborted || response.destroyed) abort();
      controller.signal.throwIfAborted();
      const payload = decodePaymentSignatureHeader(
        request.get('PAYMENT-SIGNATURE')!,
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
        ceiling: inferenceCeiling(
          input,
          options.tokenizer,
          model.contextTokens,
        ),
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
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
      };
      const billedTokens =
        options.billingOverride?.(
          input.requestId,
          Object.freeze({ ...engineTokens }),
        ) ?? engineTokens;
      const actual = charge(billedTokens);
      if (
        actual >
        BigInt(inferenceCeiling(input, options.tokenizer, model.contextTokens))
      )
        throw new Error('Usage exceeds authorized ceiling.');
      setSettlementOverrides(response, { amount: actual.toString() });
      response.json({
        requestId: input.requestId,
        offer: OFFER_ID,
        model: model.name,
        digest: model.digest,
        content: result.text,
        usage: inferenceWireUsage(result.usage),
        meteringMode: capabilities.recountable ? 'recounted' : 'declared',
        billedTokens,
        done: true,
        doneReason: result.finishReason,
      });
    } catch {
      // Explicitly end the Express 4 response so x402 cancels and settles zero.
      setSettlementOverrides(response, { amount: '0' });
      response.status(HTTP_STATUS.badGateway).json({
        requestId: input.requestId,
        error:
          'Local inference failed; inspect confirmed settlement for refund.',
      });
    } finally {
      request.removeListener('aborted', abort);
      response.removeListener('close', abort);
    }
  });
  return { app };
}
