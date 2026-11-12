// Starts the isolated free buyer using local role identity and selection policy, without paid bootstrap.
import { BUYER_RELAY_ONLY_ENV, FREE_OUTPUT_TOKENS } from '@gyblos/config';
import { withBuyerRuntime } from '@gyblos/node/buyer-runtime';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import {
  createBuyerReceiptRuntime,
  openReceiptStore,
} from '@gyblos/node/receipts';
import { loadRole, nodeSecret, type RoleConfig } from '@gyblos/node/roles';
import {
  createLocalTelemetry,
  loadLocalTelemetry,
} from '@gyblos/node/telemetry-startup';
import { P2P_ROLES, REASONING_LEVELS } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import {
  assertConfiguredRelay,
  bindEndpoint,
} from '@gyblos/transport-iroh/endpoint';

import { ownedChat } from './chat-owned';
import {
  BUYER_SELECTION_CODES,
  FREE_BUYER_STARTUP,
  type FreeBuyerStartupReason,
} from './constants';
import { executeBuyerFree, type FreeBuyerDependencies } from './free-execution';
import { startFreeBuyerHttp, type ChatErrorClassifier } from './free-http';
import { freeBuyerDependencies } from './free-selection';
import type { ChatResult } from './free-sse';
import type { RoutedModel } from './model-routes';
import { loadBuyerSelectionConfig } from './selection-config';
import { prepareConfiguredBuyerSelection } from './selection-runtime';
import type { SellerFailureReporter } from './seller-failures';

// A host composition seam: transports, admission and quote verification remain in existing modules.
export type BuyerExecutionFactory = (context: {
  prepared: Awaited<ReturnType<typeof buyerSelection>>;
  role: RoleConfig;
  endpoint: Awaited<ReturnType<typeof bindEndpoint>>;
  relayOnly: boolean;
  dependencies: FreeBuyerDependencies;
}) => Promise<{
  execute(
    input: FreeExecutionBuildInput,
    signal: AbortSignal,
    onDelta?: (text: string, requestDigest?: string) => Promise<void>,
    // The model the request named, when the endpoint serves several.
    model?: RoutedModel,
  ): Promise<ChatResult>;
  token?: string;
  requestMs?: number;
  classify?: ChatErrorClassifier;
  chat(url: string): ReturnType<typeof ownedChat> & { automatic?: boolean };
  drain?(): Promise<unknown>;
  close(): Promise<void>;
  inspect?(
    digest: string,
    signal?: AbortSignal,
  ): Promise<{ chargedAtomic: string; refundedAtomic: string } | undefined>;
}>;

// A startup refusal with a static reason; it never carries paths or file contents.
export class FreeBuyerStartupError extends Error {
  constructor(readonly reason: FreeBuyerStartupReason) {
    super(reason);
    this.name = 'FreeBuyerStartupError';
  }
}
export const refuse = (reason: FreeBuyerStartupReason): never => {
  throw new FreeBuyerStartupError(reason);
};

export async function buyerRole() {
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
export async function buyerSelection() {
  const config =
    (await selectionConfig()) ?? refuse(FREE_BUYER_STARTUP.SELECTION_MISSING);
  try {
    return await prepareConfiguredBuyerSelection(process.env, config);
  } catch (error) {
    return refuse(stateReason(error));
  }
}
function freeChat(
  request: Awaited<ReturnType<typeof buyerSelection>>['config']['request'],
  url: string,
) {
  return ownedChat(request.selection.modelId, request.maxTokens, '0', url);
}
export async function listenOrRefuse<T>(listen: () => Promise<T>) {
  try {
    return await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      refuse(FREE_BUYER_STARTUP.PORT_IN_USE);
    throw error;
  }
}
export async function buyerNodeSecret() {
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
// Stop admission and bound draining before the endpoint closes; only then release payment journals.
async function closeBuyerResources(
  receipts: ReturnType<typeof createBuyerReceiptRuntime> | undefined,
  endpoint: Awaited<ReturnType<typeof bindEndpoint>>,
  telemetry: ReturnType<typeof createLocalTelemetry>,
  host?: Pick<Awaited<ReturnType<typeof startFreeBuyerHttp>>, 'close'>,
  execution?: Awaited<ReturnType<BuyerExecutionFactory>>,
) {
  try {
    try {
      await host?.close();
    } finally {
      await execution?.drain?.();
    }
  } finally {
    try {
      await receipts?.close();
    } finally {
      try {
        await endpoint.close();
      } finally {
        try {
          await execution?.close();
        } finally {
          await telemetry.close();
        }
      }
    }
  }
}

function buyerHttp(
  run: Awaited<ReturnType<BuyerExecutionFactory>>['execute'],
  { request, models }: Awaited<ReturnType<typeof buyerSelection>>['config'],
  port?: number,
  execution?: Awaited<ReturnType<BuyerExecutionFactory>>,
) {
  return listenOrRefuse(() =>
    startFreeBuyerHttp(
      (input, signal, _onDelta, model) => run(input, signal, undefined, model),
      {
        selection: request.selection,
        maxTokens: request.maxTokens,
        ...(models ? { models } : {}),
        // The selected execution policy, not its price, determines admission after capability validation.
        tools: true,
      },
      {
        port,
        stream: run,
        token: execution?.token,
        requestMs: execution?.requestMs,
        classify: execution?.classify,
      },
    ),
  );
}

function buyerHost(
  host: Awaited<ReturnType<typeof startFreeBuyerHttp>>,
  request: Awaited<ReturnType<typeof buyerSelection>>['config']['request'],
  receipts: ReturnType<typeof createBuyerReceiptRuntime>,
  endpoint: Awaited<ReturnType<typeof bindEndpoint>>,
  telemetry: ReturnType<typeof createLocalTelemetry>,
  execution?: Awaited<ReturnType<BuyerExecutionFactory>>,
) {
  return {
    url: host.url,
    chat: execution?.chat(host.url) ?? freeChat(request, host.url),
    receipts: receipts.health,
    telemetry: telemetry.health,
    close: () =>
      closeBuyerResources(receipts, endpoint, telemetry, host, execution),
    inspectAndClose: execution?.inspect
      ? async (digest: string, signal?: AbortSignal) => {
          try {
            await host.close();
            return await execution?.inspect?.(digest, signal);
          } finally {
            await closeBuyerResources(
              receipts,
              endpoint,
              telemetry,
              undefined,
              execution,
            );
          }
        }
      : undefined,
  };
}

async function startOwnedFreeBuyer(
  options: {
    bind?: typeof bindEndpoint;
    port?: number;
    telemetry?: TelemetrySink;
    onSellerFailure?: SellerFailureReporter;
    execution?: BuyerExecutionFactory;
  } = {},
) {
  const telemetryEnabled = await loadLocalTelemetry(process.env);
  const role = await buyerRole();
  if (role.role !== P2P_ROLES.BUYER)
    return refuse(FREE_BUYER_STARTUP.NOT_BUYER);
  const prepared = await buyerSelection();
  const { request } = prepared.config;
  // Paid mode checks its own, smaller bound before it gets here.
  if (request.maxTokens > FREE_OUTPUT_TOKENS.max)
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
  let execution: Awaited<ReturnType<BuyerExecutionFactory>> | undefined;
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
    execution = await options.execution?.({
      prepared,
      role,
      endpoint,
      relayOnly,
      dependencies,
    });
    const run: Awaited<ReturnType<BuyerExecutionFactory>>['execute'] =
      execution?.execute ??
      ((input, signal, onDelta, model) =>
        executeBuyerFree(input, dependencies, signal, onDelta, model));
    const host = await buyerHttp(run, prepared.config, options.port, execution);
    return buyerHost(host, request, receipts, endpoint, telemetry, execution);
  } catch (error) {
    await closeBuyerResources(
      receipts,
      endpoint,
      telemetry,
      undefined,
      execution,
    );
    throw error;
  }
}

// All executable modes sharing this home take the same lifetime owner before any financial factory.
export async function startFreeBuyer(
  options: Parameters<typeof startOwnedFreeBuyer>[0] = {},
) {
  await buyerRole();
  return withBuyerRuntime(process.env, () => startOwnedFreeBuyer(options));
}
