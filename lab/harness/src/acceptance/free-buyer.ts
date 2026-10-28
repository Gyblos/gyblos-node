// Composes the real free buyer/HTTP endpoint with a local index and independent identity map.
// Faults cut a native dial or lose an actual native response; no substitute transport executes requests.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Connection, Endpoint } from '@number0/iroh';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { PreparedBuyerSelection } from '@gyblos/buyer/selection-runtime';
import { selectionStats } from '@gyblos/buyer/selection-stats';
import { FILE_MODES, homeLayout } from '@gyblos/config';
import { FREE_EXECUTION, FREE_STREAM } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import { acceptanceSelection } from './buyer';
import { acceptanceAssert } from './errors';
import {
  FREE_ACCEPTANCE,
  FREE_ACCEPTANCE_FAULTS,
  type FreeAcceptanceFault,
} from './free-constants';
import { acceptanceChat, assertChatAnswer } from './free-http';
import { createAcceptanceBuyerEndpoint } from './native';
import type { AcceptanceSession } from './session';

function injectFault(endpoint: Endpoint, fault?: FreeAcceptanceFault) {
  const connect = endpoint.connect.bind(endpoint);
  const dials: string[] = [];
  let injected = false;
  endpoint.connect = async (...args) => {
    const free = [FREE_EXECUTION.alpn, FREE_STREAM.alpn].some(
      (alpn) => Buffer.from(args[1]).toString('utf8') === alpn,
    );
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
export interface FreeBuyerIdentityOptions {
  rpcUrl: string;
  manualTrust?: boolean;
  beforeExecute?: () => Promise<void>;
}
export async function createFreeBuyer(
  run: AcceptanceSession,
  sellers: AcceptanceSession[] = [run],
  fault?: FreeAcceptanceFault,
  identity?: FreeBuyerIdentityOptions,
) {
  const { freeBuyerDependencies } =
    await import('@gyblos/buyer/free-selection');
  const endpoint = await createAcceptanceBuyerEndpoint();
  let closeHttp: (() => Promise<void>) | undefined;
  try {
    const dials = injectFault(endpoint, fault);
    const config: BuyerSelectionConfig = acceptanceSelection(run);
    config.request.maxTokens = FREE_ACCEPTANCE.maxTokens;
    config.request.maxAtomic = '0';
    config.request.priceCeilings = {
      inputAtomicPerMtok: '0',
      outputAtomicPerMtok: '0',
    };
    const configuredSellers = () =>
      sellers
        .flatMap((seller) => acceptanceSelection(seller).sellers)
        .map((seller) =>
          identity
            ? { ...seller, manualTrust: identity.manualTrust ?? false }
            : seller,
        );
    config.sellers = configuredSellers();
    let prepared: PreparedBuyerSelection;
    if (identity) {
      const url = new URL(identity.rpcUrl);
      acceptanceAssert(
        url.origin.startsWith('http://127.0.0.1:') &&
          url.pathname === '/' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash,
      );
      config.identity = { rpcUrl: identity.rpcUrl };

      const path = join(
        homeLayout(run.workspace.environment).roles.buyer,
        BUYER_SELECTION.configFile,
      );
      await writeFile(path, JSON.stringify(config), {
        mode: FILE_MODES.privateFile,
      });
      const { prepareBuyerSelection } =
        await import('@gyblos/buyer/selection-runtime');
      const loaded = await prepareBuyerSelection(run.workspace.environment);
      acceptanceAssert(loaded?.identity);
      prepared = loaded;
    } else
      prepared = {
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
    const execute = (
      input: FreeExecutionBuildInput,
      signal: AbortSignal,
      onDelta?: (text: string) => Promise<void>,
    ) =>
      executeBuyerFree(
        input,
        {
          ...dependencies,
          execute: async (...args) => {
            await identity?.beforeExecute?.();
            return dependencies.execute(...args);
          },
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
        onDelta,
      );
    const host = await startFreeBuyerHttp(
      execute,
      {
        selection: config.request.selection,
        maxTokens: config.request.maxTokens,
      },
      { port: 0, stream: execute },
    );
    closeHttp = host.close;
    return {
      url: host.url,
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
        prepared.config.sellers = configuredSellers();
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
