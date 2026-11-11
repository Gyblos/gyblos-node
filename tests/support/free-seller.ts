// Builds ephemeral free quotes and an injectable synthetic engine; no files, payment services or real keys.
import { createControlQuote } from '@gyblos/core/control-quotes';
import { FreeSellerLedger } from '@gyblos/core/free-admission';
import type { SellerFreeExecutionOptions } from '@gyblos/node/free-execution';
import { recountedMeter, type FreeMeter } from '@gyblos/node/free-meter';
import { sellerLimits } from '@gyblos/node/node-config-limits';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  type FreeChatRole,
} from '@gyblos/protocol/constants';
import type { EngineInput, EngineResult } from '@gyblos/protocol/engine';

import { controlFixture } from './control-fixture';

export async function freeSellerFixture(
  // The answer limit defaults to the seller's own default, as gyblos.toml leaves it.
  caps: {
    dailyTokenCap: number;
    perBuyerCap: number;
    maxOutputTokens?: number;
  } = { dailyTokenCap: 100, perBuyerCap: 50 },
  overrides: { meter?: FreeMeter } = {},
) {
  const api = await import('@gyblos/node/free-execution');
  const source = await controlFixture(true);
  let calls = 0;
  let lastInput: EngineInput | undefined;
  let now = source.context.now();
  let busy = false;
  let text = 'answer';
  let inputCount = 4;
  let outputCount = 2;
  let run = async (): Promise<EngineResult> => ({
    text,
    usage: {
      inputTokens: 4,
      outputTokens: 2,
      totalDurationNs: 0,
      loadDurationNs: 0,
      inputDurationNs: 0,
      outputDurationNs: 0,
    },
    finishReason: ENGINE_DONE_REASONS.STOP,
  });
  const model = source.context.models[0]!;
  const options: SellerFreeExecutionOptions = {
    owner: source.context.owner,
    nodeId: source.context.nodeId,
    offer: {
      kind: OFFER_PRICING_KINDS.FREE,
      modelId: MODEL_IDS.QWEN3_0_6B,
      reasoning: model.reasoning,
      caps: { maxOutputTokens: 4096, ...caps },
    },
    selection: model.selection,
    model: model.model,
    capabilities: model.capabilities,
    engine: {
      describe: async () => {
        throw new Error('unexpected describe');
      },
      capabilities: () => {
        throw new Error('unexpected capabilities');
      },
      generate: async (input) => {
        calls++;
        lastInput = input;
        return run();
      },
    },
    meter:
      overrides.meter ??
      recountedMeter({
        input: () => inputCount,
        chat: () => inputCount,
        count: () => outputCount,
      }),
    readiness: () => ({ ...source.context.readiness(), busy }),
    now: () => now,
    ledger: new FreeSellerLedger(now - 1, sellerLimits().maxFreeBuyers),
  };
  const service = api.createSellerFreeExecution(options);
  async function request(
    sequence = 1,
    peer = source.request.params.buyerNodeId,
    // A conversation and answer size other than one short user message.
    input: {
      messages?: { role: FreeChatRole; content: string }[];
      maxTokens?: number;
    } = {},
  ) {
    const maxTokens = input.maxTokens ?? 10;
    const query = {
      ...source.request,
      requestId: sequence.toString(16).padStart(32, '0'),
      params: { ...source.request.params, buyerNodeId: peer, maxTokens },
    };
    const quote = await createControlQuote(
      query,
      { ...source.context, remoteNodeId: peer },
      source.ownerSigner,
    );
    return {
      version: FREE_EXECUTION.version,
      requestId: quote.offer.requestId,
      quote,
      input: {
        messages: input.messages ?? [
          { role: FREE_CHAT_ROLES.USER, content: 'hello' },
        ],
        selection: quote.offer.selection,
        reasoning: quote.offer.reasoning,
        maxTokens,
      },
    };
  }
  return {
    service,
    options,
    source,
    request,
    calls: () => calls,
    lastInput: () => lastInput,
    setText(value: string) {
      text = value;
    },
    setCounts(input: number, output: number) {
      inputCount = input;
      outputCount = output;
    },
    setNow: (value: number) => {
      now = value;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
    setRun: (value: typeof run) => {
      run = value;
    },
  };
}
export const freeSellerSignal = () => new AbortController().signal;
