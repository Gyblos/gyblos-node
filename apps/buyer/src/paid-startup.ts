// Starts the paid buyer on devnet behind the same loopback endpoint as the free one: the role's wallet
// and RPC (proven devnet), the pinned public tokenizer for its own recount, the payment journal (one
// buyer process at a time) and selection quoted at the configured ceilings. Refusals carry static reasons.
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
import type { UptoBuyerPayments } from '@gyblos/payments-upto';
import {
  MODEL_IDS,
  P2P_ROLES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import { FREE_BUYER_STARTUP, PAID_BUYER } from './constants';
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
    return refuse(FREE_BUYER_STARTUP.JOURNAL);
  }
}

async function closePaidResources(
  chain: UptoBuyerPayments,
  endpoint?: Awaited<ReturnType<typeof bindEndpoint>>,
  host?: { close(): Promise<void> },
) {
  try {
    await host?.close();
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
    const chat = paidChat(
      paidBuyerDependencies(prepared, {
        endpoint,
        buyer: role.buyer,
        relayOnly,
        onSellerFailure: options.onSellerFailure,
        payment: chain.client,
        fee: PROTOCOL_FEE,
        meter,
        record: records.record,
      }),
    );
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
          // The request itself, then checking its settlement and recording the outcome.
          requestMs: PAID_BUYER.requestMs + 2 * PAID_BUYER.receiptMs,
        },
      ),
    );
    return {
      url: host.url,
      close: () => closePaidResources(chain, bound, host),
    };
  } catch (error) {
    await closePaidResources(chain, endpoint);
    throw error;
  }
}
