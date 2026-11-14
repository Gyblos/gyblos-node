// Main-process-only connection to an explicitly configured, authenticated loopback buyer.
// It never retries a transmitted request or treats a seller's unverified claim as a payment.
import { LOCALHOST, ROUTES } from '@gyblos/config';
import { DEVNET_USDC } from '@gyblos/config/network';
import { AGENT_SETUP_CODES, AgentSetupError } from '@gyblos/node/agent-setup';
import { PAID_BUYER_CODES, PAID_VERDICTS } from '@gyblos/node/constants';
import {
  BUYER_API,
  buyerAtomic,
  type BuyerApiPolicy,
} from '@gyblos/protocol/buyer-api';
import type { BuyerApiKeyCommand } from '@gyblos/protocol/buyer-api-keys';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';

import { requestAgentEndpoint } from './agent-endpoint';
import { RESPONSE_COST_KIND, RESPONSE_COST_UNIT } from './constants';
import { observedResponse, reportedUsage } from './response-metrics';
import { requestBuyerApiKeys } from './usdc-api-client';
import { X402Budget } from './x402-budget';
import {
  DESKTOP_X402,
  x402Amount,
  x402Policy,
  x402Signature,
} from './x402-model';

export function buyerEndpoint(input: unknown) {
  if (typeof input !== 'string') throw new Error('Enter a local buyer URL');
  const url = new URL(input);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOCALHOST ||
    !url.port ||
    url.pathname !== ROUTES.inference ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use the local buyer URL at http://127.0.0.1:port/v1/chat/completions',
    );
  return url;
}
async function readJson(response: Response, allowError = false) {
  if ((!response.ok && !allowError) || !response.body)
    throw new Error('Buyer did not complete the request');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > DESKTOP_X402.MAX_RESPONSE)
        throw new Error('Buyer response is too large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value: unknown = JSON.parse(text);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid buyer response');
  return value as Record<string, unknown>;
}
export function parseBuyerReply(input: unknown, policy: BuyerApiPolicy) {
  const value = object(input);
  if (
    value.model !== policy.model ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    throw new Error('Invalid buyer response');
  const choice = object(value.choices[0]);
  const message = object(choice.message);
  if (
    message.role !== FREE_CHAT_ROLES.ASSISTANT ||
    typeof message.content !== 'string' ||
    message.content.length > DESKTOP_X402.MAX_RESPONSE ||
    (choice.finish_reason !== ENGINE_DONE_REASONS.STOP &&
      choice.finish_reason !== ENGINE_DONE_REASONS.LENGTH)
  )
    throw new Error('Incomplete buyer response');
  const payment = value[BUYER_API.PAYMENT_FIELD];
  const usage = reportedUsage(value.usage, policy.maxTokens);
  if (
    value[BUYER_API.EXECUTION_FIELD] === OFFER_PRICING_KINDS.FREE &&
    payment === undefined
  )
    return {
      text: message.content,
      chargeAtomic: '0',
      transaction: null,
      free: true,
      usage,
    };
  const paid = object(payment);
  if (
    paid.verdict !== PAID_VERDICTS.SETTLED ||
    typeof paid.transaction !== 'string' ||
    !x402Signature(paid.transaction) ||
    !buyerAtomic(paid.maxAtomic) ||
    !buyerAtomic(paid.expectedAtomic) ||
    !buyerAtomic(paid.chargedAtomic) ||
    !buyerAtomic(paid.refundedAtomic) ||
    paid.expectedAtomic !== paid.chargedAtomic ||
    BigInt(paid.maxAtomic) > BigInt(policy.maxAtomic) ||
    BigInt(paid.chargedAtomic) + BigInt(paid.refundedAtomic) !==
      BigInt(paid.maxAtomic) ||
    value[BUYER_API.EXECUTION_FIELD] === OFFER_PRICING_KINDS.FREE
  )
    throw new Error(
      'Payment is not confirmed. Further messages are blocked until review.',
    );
  return {
    text: message.content,
    chargeAtomic: paid.chargedAtomic,
    transaction: paid.transaction,
    free: false,
    usage,
  };
}
export class X402Client {
  private connection: {
    url: URL;
    token: string;
    policy: BuyerApiPolicy;
  } | null = null;
  private busy = false;
  private closed = false;
  private controller: AbortController | null = null;
  private pending: Promise<unknown> | null = null;
  private readonly keyRequests = new Map<Promise<unknown>, AbortController>();
  constructor(
    readonly budget: X402Budget,
    private readonly request: typeof fetch = fetch,
  ) {}
  policy() {
    return this.connection ? { ...this.connection.policy } : null;
  }
  disconnect() {
    for (const controller of this.keyRequests.values()) controller.abort();
    this.connection = null;
    this.controller?.abort();
  }
  async connect(input: unknown, token: unknown) {
    if (this.busy || this.closed || this.keyRequests.size > 0)
      throw new Error('Wait for the current response');
    const url = buyerEndpoint(input);
    if (
      typeof token !== 'string' ||
      token.length < DESKTOP_X402.MIN_TOKEN_LENGTH ||
      token.length > DESKTOP_X402.MAX_TOKEN_LENGTH ||
      /[\s\r\n]/.test(token)
    )
      throw new Error('Enter the local buyer API key');
    this.busy = true;
    try {
      const response = await this.request(new URL(BUYER_API.STATUS_PATH, url), {
        headers: { authorization: 'Bearer ' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(DESKTOP_X402.STATUS_MS),
      });
      const policy = x402Policy(await readJson(response));
      this.connection = { url, token, policy };
      return policy;
    } finally {
      this.busy = false;
    }
  }
  manageApiKeys(command?: BuyerApiKeyCommand) {
    if (!this.connection || this.closed || (command && this.busy))
      return Promise.reject(
        new Error('Connect the local buyer and wait for the current response'),
      );
    const connection = this.connection;
    const controller = new AbortController();
    const work = requestBuyerApiKeys(
      connection,
      this.request,
      controller.signal,
      command,
    ).then((result) => {
      if (this.closed || this.connection !== connection)
        throw new Error('Buyer connection changed');
      return result;
    });
    this.keyRequests.set(work, controller);
    return work.finally(() => {
      this.keyRequests.delete(work);
    });
  }
  async authorize(limit: string) {
    if (!this.connection || this.busy || this.closed)
      throw new Error('Connect the local buyer first');
    this.busy = true;
    try {
      return await this.budget.authorize(this.connection.policy, limit);
    } finally {
      this.busy = false;
    }
  }
  agentEndpoint() {
    if (!this.connection || this.closed)
      return Promise.reject(new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT));
    const connection = this.connection;
    const controller = new AbortController();
    const work = requestAgentEndpoint(
      connection,
      this.request,
      controller.signal,
    ).then((endpoint) => {
      if (this.closed || this.connection !== connection)
        throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
      return endpoint;
    });
    this.keyRequests.set(work, controller);
    return work.finally(() => {
      this.keyRequests.delete(work);
    });
  }
  send(id: string, prompt: string) {
    if (this.busy || this.closed || !this.connection)
      return Promise.reject(new Error('Local buyer is unavailable'));
    if (!prompt.trim() || Buffer.byteLength(prompt) > DESKTOP_X402.MAX_PROMPT)
      return Promise.reject(new Error('Message is empty or too large'));
    this.busy = true;
    const connection = this.connection;
    const controller = new AbortController();
    this.controller = controller;
    const work = this.execute(connection, id, prompt, controller.signal);
    this.pending = work;
    return work.finally(() => {
      this.busy = false;
      this.controller = null;
      this.pending = null;
    });
  }
  private async execute(
    connection: NonNullable<X402Client['connection']>,
    id: string,
    prompt: string,
    external: AbortSignal,
  ) {
    const current = await this.budget.summary();
    if (current.policy?.policyId !== connection.policy.policyId)
      throw new Error(
        'Buyer policy changed. Finish the previous budget before authorizing another.',
      );
    const policy = await this.budget.reserve(id);
    const started = performance.now();
    const response = await this.request(
      new URL(BUYER_API.CHAT_PATH, connection.url),
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([
          external,
          AbortSignal.timeout(DESKTOP_X402.REQUEST_MS),
        ]),
        headers: {
          authorization: 'Bearer ' + connection.token,
          'content-type': 'application/json',
          'if-match': '"' + policy.policyId + '"',
        },
        body: JSON.stringify({
          model: policy.model,
          messages: [{ role: FREE_CHAT_ROLES.USER, content: prompt }],
          max_tokens: policy.maxTokens,
          stream: false,
        }),
      },
    );
    const body = await readJson(response, true);
    const responseMs = performance.now() - started;
    if (!response.ok) {
      const error = object(object(body).error);
      if (
        error[BUYER_API.NEVER_SENT_FIELD] === true &&
        error.code !== PAID_BUYER_CODES.UNRESOLVED
      )
        await this.budget.cancelUnsent(id);
      throw new Error('Buyer did not complete the request');
    }
    const reply = parseBuyerReply(body, policy);
    const summary = await this.budget.complete(id, reply);
    const metrics = observedResponse(
      responseMs,
      {
        amount: x402Amount(reply.chargeAtomic, policy),
        unit:
          policy.mint === DEVNET_USDC
            ? RESPONSE_COST_UNIT.USDC
            : RESPONSE_COST_UNIT.ATOMIC,
        kind: RESPONSE_COST_KIND.SETTLED,
      },
      reply.usage,
    );
    return { text: reply.text, model: policy.model, summary, metrics };
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    for (const controller of this.keyRequests.values()) controller.abort();
    await Promise.allSettled(this.keyRequests.keys());
    await this.pending?.catch(() => {});
  }
}
