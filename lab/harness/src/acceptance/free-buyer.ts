// Composes the real free buyer/HTTP endpoint with a local index and independent identity map.
// Faults cut a native dial or lose an actual native response; no substitute transport executes requests.
import type { Connection, Endpoint } from '@number0/iroh';

import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { selectionStats } from '@gyblos/buyer/selection-stats';
import { FREE_EXECUTION } from '@gyblos/protocol/constants';

import { acceptanceSelection } from './buyer.js';
import { acceptanceAssert } from './errors.js';
import {
  FREE_ACCEPTANCE,
  FREE_ACCEPTANCE_FAULTS,
  type FreeAcceptanceFault,
} from './free-constants.js';
import { acceptanceChat, assertChatAnswer } from './free-http.js';
import { createAcceptanceBuyerEndpoint } from './native.js';
import type { AcceptanceSession } from './session.js';

function injectFault(endpoint: Endpoint, fault?: FreeAcceptanceFault) {
  const connect = endpoint.connect.bind(endpoint);
  const dials: string[] = [];
  let injected = false;
  endpoint.connect = async (...args) => {
    const free = Buffer.from(args[1]).toString('utf8') === FREE_EXECUTION.alpn;
    if (free) dials.push(args[0].id().toString());
    if (free && fault === FREE_ACCEPTANCE_FAULTS.DIAL && !injected) {
      injected = true;
      throw new Error('Synthetic dial failure');
    }
    const connection = await connect(...args);
    if (free && fault === FREE_ACCEPTANCE_FAULTS.RESPONSE && !injected) {
      injected = true;
      loseResponse(connection);
    }
    return connection;
  };
  return dials;
}
function loseResponse(connection: Connection) {
  const open = connection.openBi.bind(connection);
  connection.openBi = async () => {
    const stream = await open();
    const receiving = stream.recv;
    const read = receiving.readExact.bind(receiving);
    receiving.readExact = async (size) => {
      await read(size);
      throw new Error('Synthetic response loss');
    };
    Object.defineProperty(stream, 'recv', { value: receiving });
    return stream;
  };
}
export async function createFreeBuyer(
  run: AcceptanceSession,
  sellers: AcceptanceSession[] = [run],
  fault?: FreeAcceptanceFault,
) {
  const { freeBuyerDependencies } =
    await import('@gyblos/buyer/free-selection');
  const endpoint = await createAcceptanceBuyerEndpoint();
  let closeHttp: (() => Promise<void>) | undefined;
  try {
    const dials = injectFault(endpoint, fault);
    const config = acceptanceSelection(run);
    config.request.maxTokens = FREE_ACCEPTANCE.maxTokens;
    config.request.maxAtomic = '0';
    config.request.priceCeilings = {
      inputAtomicPerMtok: '0',
      outputAtomicPerMtok: '0',
    };
    config.sellers = sellers.flatMap(
      (seller) => acceptanceSelection(seller).sellers,
    );
    const prepared = {
      config,
      stats: await selectionStats(run.workspace.environment),
      discovery: run.state(),
    };
    let dependencies = freeBuyerDependencies(prepared, {
      endpoint,
      buyer: run.identity.buyer.address,
      relayOnly: false,
      now: run.clock.now,
      fetch: run.index.fetch,
    });
    let selections = 0;
    let queryGenerations = 0;
    let queryEngineAttempts = 0;
    const generations = () =>
      sellers.reduce((sum, seller) => sum + seller.engine.generations(), 0);
    const host = await startFreeBuyerHttp(
      (input, signal) =>
        executeBuyerFree(
          input,
          {
            ...dependencies,
            select: async (excluded, deadline) => {
              const before = generations();
              const attempts = sellers.reduce(
                (sum, seller) => sum + seller.engine.attempts(),
                0,
              );
              selections++;
              try {
                return await dependencies.select(excluded, deadline);
              } finally {
                const delta = generations() - before;
                queryGenerations += delta;
                const attempted =
                  sellers.reduce(
                    (sum, seller) => sum + seller.engine.attempts(),
                    0,
                  ) - attempts;
                queryEngineAttempts += attempted;
                acceptanceAssert(delta === 0 && attempted === 0);
              }
            },
          },
          AbortSignal.any([signal, run.signal]),
        ),
      {
        selection: config.request.selection,
        maxTokens: config.request.maxTokens,
      },
      { port: 0 },
    );
    closeHttp = host.close;
    return {
      endpoint,
      dials,
      generations,
      selections: () => selections,
      queryGenerations: () => queryGenerations,
      queryEngineAttempts: () => queryEngineAttempts,
      chat: () => acceptanceChat(host.url, run.signal),
      async answer() {
        const before = generations();
        assertChatAnswer(await acceptanceChat(host.url, run.signal));
        acceptanceAssert(generations() === before + 1);
      },
      refresh() {
        prepared.config.sellers = sellers.flatMap(
          (seller) => acceptanceSelection(seller).sellers,
        );
        prepared.discovery = run.state();
        dependencies = freeBuyerDependencies(prepared, {
          endpoint,
          buyer: run.identity.buyer.address,
          relayOnly: false,
          now: run.clock.now,
          fetch: run.index.fetch,
        });
      },
      async close() {
        try {
          await host.close();
        } finally {
          await endpoint.close();
        }
      },
    };
  } catch (error) {
    await closeHttp?.();
    await endpoint.close();
    throw error;
  }
}
export type FreeAcceptanceBuyer = Awaited<ReturnType<typeof createFreeBuyer>>;
