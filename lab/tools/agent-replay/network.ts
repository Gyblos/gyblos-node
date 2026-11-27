import { performance } from 'node:perf_hooks';

import {
  executeBuyerFree,
  type FreeBuyerDependencies,
} from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { freeBuyerDependencies } from '@gyblos/buyer/free-selection';
import { selectionStats } from '@gyblos/buyer/selection-stats';
import { SELLER_READINESS, TRANSPORT_LIMITS } from '@gyblos/config';
import { acceptanceSelection } from '@gyblos/lab-harness/acceptance/buyer';
import { createAcceptanceClock } from '@gyblos/lab-harness/acceptance/clock';
import {
  ACCEPTANCE_MODES,
  type AcceptanceMode,
} from '@gyblos/lab-harness/acceptance/constants';
import { createFreeSeller } from '@gyblos/lab-harness/acceptance/free-session';
import { createAcceptanceBuyerEndpoint } from '@gyblos/lab-harness/acceptance/native';
import type { AcceptanceSession } from '@gyblos/lab-harness/acceptance/session';

import { AGENT_REPLAY } from './constants';

type FreeChatStreamExecutor = NonNullable<
  NonNullable<Parameters<typeof startFreeBuyerHttp>[2]>['stream']
>;

export interface CooldownEvent {
  atMs: number;
  seller: number;
  phase: string;
  code: string;
  cooldownMs: number | null;
}

export interface SellerTrace {
  tag: string;
  sellers: number[];
  waitsMs: number[];
  selectError?: string;
}

function requestTag(input: Parameters<FreeChatStreamExecutor>[0]) {
  const last = input.messages.at(-1);
  const text = typeof last?.content === 'string' ? last.content : '';
  const start = text.indexOf(AGENT_REPLAY.tagPrefix);
  return start < 0 ? '' : text.slice(start).split(/\s/)[0]!;
}

function renewLikeProduction(sellers: AcceptanceSession[]) {
  const renew = async (seller: AcceptanceSession) => {
    const host = seller.host();
    await host.observation.tick();
    const state = host.observation.readiness();
    if (!state.busy && state.validUntil > Date.now())
      await host.control.records.refresh().catch(() => {});
    await host.publisher.tick();
  };
  const timer = setInterval(() => {
    for (const seller of sellers) void renew(seller).catch(() => {});
  }, SELLER_READINESS.tickMs);
  return () => clearInterval(timer);
}

async function startSellers(
  count: number,
  signal: AbortSignal,
  mode?: AcceptanceMode,
) {
  const engine = { mode, pace: AGENT_REPLAY.pace, caps: AGENT_REPLAY.caps };
  const sellers: AcceptanceSession[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const seller = await createFreeSeller(
        signal,
        sellers[0] ?? {
          clock: createAcceptanceClock(ACCEPTANCE_MODES.OLLAMA, signal),
        },
        false,
        engine,
      );
      sellers.push(seller);
      if (!(await seller.host().publisher.tick()))
        throw new Error('seller did not publish');
    }
    return sellers;
  } catch (error) {
    await Promise.allSettled(sellers.map((seller) => seller.close()));
    throw error;
  }
}

function traced(
  dependencies: FreeBuyerDependencies,
  nodes: string[],
  traces: Map<string, SellerTrace>,
): FreeChatStreamExecutor {
  return (input, signal, onDelta, model) => {
    const trace: SellerTrace = {
      tag: requestTag(input),
      sellers: [],
      waitsMs: [],
    };
    traces.set(trace.tag, trace);
    return executeBuyerFree(
      input,
      {
        ...dependencies,
        async select(excluded, deadline, needs) {
          const began = performance.now();
          try {
            const winner = await dependencies.select(excluded, deadline, needs);
            trace.sellers.push(nodes.indexOf(winner.nodeId) + 1);
            trace.waitsMs.push(performance.now() - began);
            return winner;
          } catch (error) {
            trace.waitsMs.push(performance.now() - began);
            trace.selectError = error instanceof Error ? error.name : 'unknown';
            throw error;
          }
        },
      },
      signal,
      onDelta,
      model,
    );
  };
}

export async function startReplayNetwork(
  count: number,
  signal: AbortSignal,
  mode?: AcceptanceMode,
) {
  const sellers = await startSellers(count, signal, mode);
  const stopRenewal = renewLikeProduction(sellers);
  const [first] = sellers;
  let endpoint:
    Awaited<ReturnType<typeof createAcceptanceBuyerEndpoint>> | undefined;
  try {
    endpoint = await createAcceptanceBuyerEndpoint();
    const bound = endpoint;
    const config = acceptanceSelection(first!);
    config.request.maxTokens = AGENT_REPLAY.maxTokens;
    config.request.maxAtomic = '0';
    config.request.priceCeilings = {
      inputAtomicPerMtok: '0',
      outputAtomicPerMtok: '0',
    };
    config.sellers = sellers.flatMap(
      (seller) => acceptanceSelection(seller).sellers,
    );
    const traces = new Map<string, SellerTrace>();
    const cooldowns: CooldownEvent[] = [];
    const nodes = config.sellers.map((seller) => seller.nodeId);
    const origin = Date.now();
    const dependencies = freeBuyerDependencies(
      {
        config,
        stats: await selectionStats(first!.workspace.environment),
        discovery: first!.state(),
      },
      {
        endpoint: bound,
        buyer: first!.identity.buyer.address,
        relayOnly: false,
        fetch: first!.index.fetch,
        parallel: TRANSPORT_LIMITS.maxConcurrent,
        onSellerFailure: (failure) =>
          cooldowns.push({
            atMs: Date.now() - origin,
            seller: nodes.indexOf(failure.nodeId) + 1,
            phase: failure.phase,
            code: failure.code,
            cooldownMs: failure.retryAt ? failure.retryAt - Date.now() : null,
          }),
      },
    );
    const execute = traced(dependencies, nodes, traces);
    const host = await startFreeBuyerHttp(
      (input, deadline, _onDelta, model) =>
        execute(input, deadline, async () => {}, model),
      {
        selection: config.request.selection,
        maxTokens: config.request.maxTokens,
        tools: true,
      },
      { port: 0, stream: execute },
    );
    return {
      url: host.url,
      traces,
      cooldowns,
      async close() {
        stopRenewal();
        await host.close();
        await bound.close();
        await Promise.allSettled(sellers.map((seller) => seller.close()));
      },
    };
  } catch (error) {
    stopRenewal();
    await endpoint?.close();
    await Promise.allSettled(sellers.map((seller) => seller.close()));
    throw error;
  }
}
