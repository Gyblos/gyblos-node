// Starts the isolated free buyer using local role identity and selection policy, without paid bootstrap.
import { BUYER_RELAY_ONLY_ENV, INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { loadRole, nodeSecret } from '@gyblos/node/roles';
import { P2P_ROLES, REASONING_LEVELS } from '@gyblos/protocol/constants';
import { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import {
  BUYER_SELECTION_CODES,
  FREE_BUYER_STARTUP,
  type FreeBuyerStartupReason,
} from './constants';
import { executeBuyerFree } from './free-execution';
import { startFreeBuyerHttp } from './free-http';
import { freeBuyerDependencies } from './free-selection';
import { loadBuyerSelectionConfig } from './selection-config';
import { prepareConfiguredBuyerSelection } from './selection-runtime';

// A startup refusal with a static reason; it never carries paths or file contents.
export class FreeBuyerStartupError extends Error {
  constructor(readonly reason: FreeBuyerStartupReason) {
    super(reason);
    this.name = 'FreeBuyerStartupError';
  }
}
const refuse = (reason: FreeBuyerStartupReason): never => {
  throw new FreeBuyerStartupError(reason);
};

async function buyerRole() {
  try {
    return await loadRole(P2P_ROLES.BUYER);
  } catch (error) {
    return refuse(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? FREE_BUYER_STARTUP.ROLE_MISSING
        : FREE_BUYER_STARTUP.ROLE_INVALID,
    );
  }
}
// selection.json is checked on its own so that state files beside it are never blamed on it.
async function selectionConfig() {
  try {
    return await loadBuyerSelectionConfig(process.env);
  } catch {
    return refuse(FREE_BUYER_STARTUP.SELECTION_INVALID);
  }
}
function stateReason(error: unknown): FreeBuyerStartupReason {
  const code = (error as { code?: string }).code;
  if (code === BUYER_SELECTION_CODES.DISCOVERY_STATE)
    return FREE_BUYER_STARTUP.DISCOVERY_STATE;
  if (
    code === BUYER_SELECTION_CODES.IDENTITY ||
    code === BUYER_SELECTION_CODES.IDENTITY_STATE ||
    code === NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE
  )
    return FREE_BUYER_STARTUP.IDENTITY_STATE;
  // The config was already accepted, so a remaining INVALID comes from selection-stats.json.
  if (code === BUYER_SELECTION_CODES.INVALID)
    return FREE_BUYER_STARTUP.STATS_INVALID;
  return FREE_BUYER_STARTUP.UNKNOWN;
}
async function buyerSelection() {
  const config =
    (await selectionConfig()) ?? refuse(FREE_BUYER_STARTUP.SELECTION_MISSING);
  try {
    return await prepareConfiguredBuyerSelection(process.env, config);
  } catch (error) {
    return refuse(stateReason(error));
  }
}
async function listenOrRefuse<T>(listen: () => Promise<T>) {
  try {
    return await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      refuse(FREE_BUYER_STARTUP.PORT_IN_USE);
    throw error;
  }
}
async function buyerNodeSecret() {
  try {
    return await nodeSecret(P2P_ROLES.BUYER);
  } catch {
    return refuse(FREE_BUYER_STARTUP.NODE_KEY);
  }
}

export async function startFreeBuyer(
  options: { bind?: typeof bindEndpoint; port?: number } = {},
) {
  const role = await buyerRole();
  if (role.role !== P2P_ROLES.BUYER) refuse(FREE_BUYER_STARTUP.NOT_BUYER);
  const prepared = await buyerSelection();
  const { request } = prepared.config;
  if (request.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens)
    refuse(FREE_BUYER_STARTUP.MAX_TOKENS);
  // The free engine serves reasoning off only; checked before any socket is bound.
  if (
    request.reasoning !== REASONING_LEVELS.OFF ||
    request.lowestReasoning !== null
  )
    refuse(FREE_BUYER_STARTUP.REASONING);
  const relayOnly = process.env[BUYER_RELAY_ONLY_ENV] === '1';
  const endpoint = await (options.bind ?? bindEndpoint)(
    await buyerNodeSecret(),
    {
      relayOnly,
      http: false,
      bindAddress: relayOnly ? undefined : process.env.GYBLOS_IROH_BIND,
      externalAddress: process.env.GYBLOS_IROH_EXTERNAL_ADDR || undefined,
    },
  );
  try {
    if (endpoint.id().toString() !== role.nodeId)
      refuse(FREE_BUYER_STARTUP.NODE_KEY);
    const dependencies = freeBuyerDependencies(prepared, {
      endpoint,
      buyer: role.buyer,
      relayOnly,
    });
    const host = await listenOrRefuse(() =>
      startFreeBuyerHttp(
        (input, signal) => executeBuyerFree(input, dependencies, signal),
        {
          selection: prepared.config.request.selection,
          maxTokens: prepared.config.request.maxTokens,
        },
        {
          port: options.port,
          stream: (input, signal, onDelta) =>
            executeBuyerFree(input, dependencies, signal, onDelta),
        },
      ),
    );
    return {
      async close() {
        try {
          await host.close();
        } finally {
          await endpoint.close();
        }
      },
    };
  } catch (error) {
    await endpoint.close();
    throw error;
  }
}
