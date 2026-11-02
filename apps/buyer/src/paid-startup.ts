// Starts the paid buyer on devnet behind the free one's loopback endpoint, guarded by a bearer token: the
// role's wallet and RPC (proven devnet), the pinned tokenizer for its recount, the payment journal (one
// buyer at a time) and selection quoted at the configured ceilings. Refusals carry static reasons.
import {
  BUYER_RELAY_ONLY_ENV,
  DEVNET,
  INFERENCE_REQUEST_LIMITS,
  PROTOCOL_FEE,
} from '@gyblos/config';
import { modelTokenizer } from '@gyblos/node/artifacts';
import { buyerChainPayments } from '@gyblos/node/buyer-chain';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { rolePath, type RoleConfig } from '@gyblos/node/roles';
import {
  MODEL_IDS,
  P2P_ROLES,
  PAYMENT_ERROR_CODES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import { PaymentError } from '@gyblos/protocol/payment';
import { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import { ownedChat } from './chat-owned';
import {
  FREE_BUYER_STARTUP,
  PAID_BUYER,
  PAID_BUYER_HTTP_MS,
} from './constants';
import { startFreeBuyerHttp } from './free-http';
import {
  buyerNodeSecret,
  buyerRole,
  buyerSelection,
  listenOrRefuse,
  refuse,
} from './free-startup';
import { classifyPaidError, paidChat } from './paid-http';
import { paidRecords } from './paid-records';
import { paidBuyerDependencies } from './paid-selection';
import { paidToken } from './paid-token';
import type { SellerFailureReporter } from './seller-failures';

type Prepared = Awaited<ReturnType<typeof buyerSelection>>;

// The request the paid buyer can honor: the pinned model, reasoning off, devnet and the role's mint.
function checkPaidRequest(prepared: Prepared, role: RoleConfig) {
  const { request } = prepared.config;
  if (request.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens)
    refuse(FREE_BUYER_STARTUP.MAX_TOKENS);
  if (
    request.reasoning !== REASONING_LEVELS.OFF ||
    request.lowestReasoning !== null
  )
    refuse(FREE_BUYER_STARTUP.REASONING);
  if (request.selection.modelId !== MODEL_IDS.QWEN3_0_6B)
    refuse(FREE_BUYER_STARTUP.PAID_MODEL);
  if (request.network !== DEVNET || request.asset !== role.mint)
    refuse(FREE_BUYER_STARTUP.PAID_NETWORK);
}

async function tokenizer(): Promise<RecountTokenizer> {
  try {
    return await modelTokenizer();
  } catch {
    return refuse(FREE_BUYER_STARTUP.TOKENIZER);
  }
}

async function endpointToken() {
  try {
    return await paidToken(rolePath(P2P_ROLES.BUYER, PAID_BUYER.tokenFile));
  } catch {
    return refuse(FREE_BUYER_STARTUP.PAID_TOKEN);
  }
}

async function payments(
  open: ReturnType<typeof buyerChainPayments>,
  role: RoleConfig,
  maxAtomic: string,
) {
  try {
    return await open(role, maxAtomic);
  } catch (error) {
    const code = error instanceof NodeError ? error.code : undefined;
    if (code === NODE_ERROR_CODES.BUYER_PAYMENT_NETWORK_MISMATCH)
      return refuse(FREE_BUYER_STARTUP.PAID_NETWORK);
    if (code === NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID)
      return refuse(FREE_BUYER_STARTUP.PAID_KEY);
    if (
      error instanceof PaymentError &&
      error.code === PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE
    )
      return refuse(FREE_BUYER_STARTUP.JOURNAL);
    // A mint or ceiling the payment client refuses: the role or selection.json is not devnet's.
    if (error instanceof PaymentError)
      return refuse(FREE_BUYER_STARTUP.PAID_NETWORK);
    throw error;
  }
}

type Chain = Awaited<ReturnType<ReturnType<typeof buyerChainPayments>>>;

// The HTTP server first; then a paid request still checking its receipt or writing its record gets
// a bounded moment before the endpoint and the journal close under it.
async function closePaidResources(
  chain: Chain,
  endpoint?: Awaited<ReturnType<typeof bindEndpoint>>,
  host?: { close(): Promise<void> },
  idle?: () => Promise<void>,
) {
  try {
    await host?.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      idle?.(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, PAID_BUYER.drainMs);
      }),
    ]).finally(() => clearTimeout(timer));
  } finally {
    try {
      await endpoint?.close();
    } finally {
      await chain.close();
    }
  }
}

export async function startPaidBuyer(
  options: {
    bind?: typeof bindEndpoint;
    port?: number;
    onSellerFailure?: SellerFailureReporter;
    chain?: ReturnType<typeof buyerChainPayments>;
    // Tests inject a tokenizer; the default loads the pinned one from the home.
    meter?: () => Promise<RecountTokenizer>;
  } = {},
) {
  const role = await buyerRole();
  if (role.role !== P2P_ROLES.BUYER)
    return refuse(FREE_BUYER_STARTUP.NOT_BUYER);
  const prepared = await buyerSelection();
  checkPaidRequest(prepared, role);
  const meter = await (options.meter ?? tokenizer)();
  const token = await endpointToken();
  const secret = await buyerNodeSecret();
  const chain = await payments(
    options.chain ?? buyerChainPayments(),
    role,
    prepared.config.request.maxAtomic,
  );
  let endpoint: Awaited<ReturnType<typeof bindEndpoint>> | undefined;
  try {
    const relayOnly = process.env[BUYER_RELAY_ONLY_ENV] === '1';
    endpoint = await (options.bind ?? bindEndpoint)(secret, {
      relayOnly,
      http: false,
      bindAddress: relayOnly ? undefined : process.env.GYBLOS_IROH_BIND,
      externalAddress: process.env.GYBLOS_IROH_EXTERNAL_ADDR || undefined,
    });
    if (endpoint.id().toString() !== role.nodeId)
      refuse(FREE_BUYER_STARTUP.NODE_KEY);
    const records = paidRecords(
      rolePath(P2P_ROLES.BUYER, PAID_BUYER.recordsFile),
    );
    const dependencies = paidBuyerDependencies(prepared, {
      endpoint,
      buyer: role.buyer,
      relayOnly,
      onSellerFailure: options.onSellerFailure,
      payment: chain.client,
      fee: PROTOCOL_FEE,
      meter,
      record: records.record,
    });
    const chat = paidChat(dependencies);
    const bound = endpoint;
    const host = await listenOrRefuse(() =>
      startFreeBuyerHttp(
        chat.execute,
        {
          selection: prepared.config.request.selection,
          maxTokens: prepared.config.request.maxTokens,
        },
        {
          port: options.port,
          stream: chat.stream,
          classify: classifyPaidError,
          requestMs: PAID_BUYER_HTTP_MS,
          token,
        },
      ),
    );
    return {
      url: host.url,
      chat: ownedChat(
        prepared.config.request.selection.modelId,
        prepared.config.request.maxTokens,
        prepared.config.request.maxAtomic,
        host.url,
        token,
      ),
      close: () => closePaidResources(chain, bound, host, dependencies.idle),
    };
  } catch (error) {
    await closePaidResources(chain, endpoint);
    throw error;
  }
}
