import { performance } from 'node:perf_hooks';

import {
  executeBuyerFree,
  type FreeBuyerDependencies,
} from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { freeBuyerDependencies } from '@gyblos/buyer/free-selection';
import { selectionStats } from '@gyblos/buyer/selection-stats';
import { TRANSPORT_LIMITS } from '@gyblos/config';
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
  admittedAtMs: number;
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

async function startSellers(
  count: number,
  signal: AbortSignal,
  mode?: AcceptanceMode,
) {
  const engine = {
    mode,
    pace: AGENT_REPLAY.pace,
    caps: AGENT_REPLAY.caps,
    offerSet: true,
  };
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
  origin: number,
): FreeChatStreamExecutor {
  return (input, signal, onDelta, model) => {
    const trace: SellerTrace = {
      admittedAtMs: performance.now() - origin,
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

function freeConfig(sellers: AcceptanceSession[]) {
  const config = acceptanceSelection(sellers[0]!);
  config.request.maxTokens = AGENT_REPLAY.maxTokens;
  config.request.maxAtomic = AGENT_REPLAY.freePrice;
  config.request.priceCeilings = {
    inputAtomicPerMtok: AGENT_REPLAY.freePrice,
    outputAtomicPerMtok: AGENT_REPLAY.freePrice,
  };
  config.sellers = sellers.flatMap(
    (seller) => acceptanceSelection(seller).sellers,
  );
  return config;
}

export async function startReplayNetwork(
  count: number,
  signal: AbortSignal,
  mode?: AcceptanceMode,
) {
  const sellers = await startSellers(count, signal, mode);
  for (const seller of sellers) seller.host().startRenewal();
  const [first] = sellers;
  let endpoint:
    Awaited<ReturnType<typeof createAcceptanceBuyerEndpoint>> | undefined;
  try {
    endpoint = await createAcceptanceBuyerEndpoint();
    const bound = endpoint;
    const config = freeConfig(sellers);
    const traces = new Map<string, SellerTrace>();
    const cooldowns: CooldownEvent[] = [];
    const nodes = config.sellers.map((seller) => seller.nodeId);
    const origin = performance.now();
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
            atMs: performance.now() - origin,
            seller: nodes.indexOf(failure.nodeId) + 1,
            phase: failure.phase,
            code: failure.code,
            cooldownMs: failure.retryAt ? failure.retryAt - Date.now() : null,
          }),
      },
    );
    const execute = traced(dependencies, nodes, traces, origin);
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
      origin,
      traces,
      cooldowns,
      async close() {
        try {
          await host.close();
        } finally {
          try {
            await bound.close();
          } finally {
            await Promise.allSettled(sellers.map((seller) => seller.close()));
          }
        }
      },
    };
  } catch (error) {
    await endpoint?.close();
    await Promise.allSettled(sellers.map((seller) => seller.close()));
    throw error;
  }
}
