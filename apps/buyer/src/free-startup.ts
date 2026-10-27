// Starts the isolated free buyer using local role identity and selection policy, without paid bootstrap.
import { BUYER_RELAY_ONLY_ENV, INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/node/constants';
import { loadRole, nodeSecret } from '@gyblos/node/roles';
import { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import {
  FREE_BUYER_STARTUP,
  type FreeBuyerStartupReason,
} from './constants.js';
import { executeBuyerFree } from './free-execution.js';
import { startFreeBuyerHttp } from './free-http.js';
import { freeBuyerDependencies } from './free-selection.js';
import { prepareBuyerSelection } from './selection-runtime.js';

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
async function buyerSelection() {
  try {
    return await prepareBuyerSelection(process.env);
  } catch {
    return refuse(FREE_BUYER_STARTUP.SELECTION_INVALID);
  }
}

export async function startFreeBuyer(
  options: { bind?: typeof bindEndpoint; port?: number } = {},
) {
  const role = await buyerRole();
  if (role.role !== P2P_ROLES.BUYER) refuse(FREE_BUYER_STARTUP.NOT_BUYER);
  const prepared =
    (await buyerSelection()) ?? refuse(FREE_BUYER_STARTUP.SELECTION_MISSING);
  if (
    prepared.config.request.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens
  )
    refuse(FREE_BUYER_STARTUP.MAX_TOKENS);
  const relayOnly = process.env[BUYER_RELAY_ONLY_ENV] === '1';
  const endpoint = await (options.bind ?? bindEndpoint)(
    await nodeSecret(P2P_ROLES.BUYER),
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
    const host = await startFreeBuyerHttp(
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
