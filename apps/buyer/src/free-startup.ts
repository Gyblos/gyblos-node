// Starts the isolated free buyer using local role identity and selection policy, without paid bootstrap.
import { BUYER_RELAY_ONLY_ENV, INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import {
  createBuyerReceiptRuntime,
  openReceiptStore,
} from '@gyblos/node/receipts';
import { loadRole, nodeSecret } from '@gyblos/node/roles';
import {
  createLocalTelemetry,
  loadLocalTelemetry,
} from '@gyblos/node/telemetry-startup';
import { P2P_ROLES, REASONING_LEVELS } from '@gyblos/protocol/constants';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import {
  assertConfiguredRelay,
  bindEndpoint,
} from '@gyblos/transport-iroh/endpoint';

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
import type { SellerFailureReporter } from './seller-failures';

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

function buyerReceipts(
  endpoint: Awaited<ReturnType<typeof bindEndpoint>>,
  nodeId: string,
  relayOnly: boolean,
) {
  return createBuyerReceiptRuntime({
    endpoint,
    store: openReceiptStore({
      environment: process.env,
      role: P2P_ROLES.BUYER,
      nodeId: nodeId,
    }),
    signer: async (bytes) =>
      Uint8Array.from(
        endpoint
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      ),
    transport: {
      relayOnly,
      relayAllowed: (origin) => {
        try {
          assertConfiguredRelay(origin);
          return true;
        } catch {
          return false;
        }
      },
    },
  });
}
// Stop HTTP/protocol resources before draining the startup-owned log, even when a close rejects.
async function closeBuyerResources(
  receipts: ReturnType<typeof createBuyerReceiptRuntime> | undefined,
  endpoint: Awaited<ReturnType<typeof bindEndpoint>>,
  telemetry: ReturnType<typeof createLocalTelemetry>,
  host?: Pick<Awaited<ReturnType<typeof startFreeBuyerHttp>>, 'close'>,
) {
  try {
    await host?.close();
  } finally {
    try {
      await receipts?.close();
    } finally {
      try {
        await endpoint.close();
      } finally {
        await telemetry.close();
      }
    }
  }
}

export async function startFreeBuyer(
  options: {
    bind?: typeof bindEndpoint;
    port?: number;
    telemetry?: TelemetrySink;
    onSellerFailure?: SellerFailureReporter;
  } = {},
) {
  const telemetryEnabled = await loadLocalTelemetry(process.env);
  const role = await buyerRole();
  if (role.role !== P2P_ROLES.BUYER)
    return refuse(FREE_BUYER_STARTUP.NOT_BUYER);
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
  const telemetry = createLocalTelemetry({
    enabled: telemetryEnabled,
    environment: process.env,
    role: P2P_ROLES.BUYER,
    sink: options.telemetry,
  });
  let receipts: ReturnType<typeof createBuyerReceiptRuntime> | undefined;
  try {
    if (endpoint.id().toString() !== role.nodeId)
      refuse(FREE_BUYER_STARTUP.NODE_KEY);
    receipts = buyerReceipts(endpoint, role.nodeId, relayOnly);
    const dependencies = freeBuyerDependencies(prepared, {
      receipts,
      telemetry: telemetry.sink,
      onSellerFailure: options.onSellerFailure,
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
      url: host.url,
      receipts: receipts.health,
      telemetry: telemetry.health,
      close: () => closeBuyerResources(receipts, endpoint, telemetry, host),
    };
  } catch (error) {
    await closeBuyerResources(receipts, endpoint, telemetry);
    throw error;
  }
}
