// Starts the isolated free buyer using local role identity and selection policy, without paid bootstrap.
import { BUYER_RELAY_ONLY_ENV, INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/node/constants';
import { loadRole, nodeSecret } from '@gyblos/node/roles';
import { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import { FREE_BUYER_CODES } from './constants.js';
import { FreeBuyerError } from './free-chat.js';
import { executeBuyerFree } from './free-execution.js';
import { startFreeBuyerHttp } from './free-http.js';
import { freeBuyerDependencies } from './free-selection.js';
import { prepareBuyerSelection } from './selection-runtime.js';

export async function startFreeBuyer(
  options: { bind?: typeof bindEndpoint; port?: number } = {},
) {
  const role = await loadRole(P2P_ROLES.BUYER);
  const prepared = await prepareBuyerSelection(process.env);
  if (
    role.role !== P2P_ROLES.BUYER ||
    !prepared ||
    prepared.config.request.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens
  )
    throw new FreeBuyerError(FREE_BUYER_CODES.CONFIG);
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
      throw new FreeBuyerError(FREE_BUYER_CODES.CONFIG);
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
      { port: options.port },
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
