// Main-process-only connection to an explicitly configured, authenticated loopback buyer.
// It never retries a transmitted request or treats a seller's unverified claim as a payment.
import { randomUUID } from 'node:crypto';

import { AGENT_SETUP_CODES, AgentSetupError } from '@gyblos/node/agent-setup';
import { PAID_BUYER_CODES } from '@gyblos/node/constants';
import {
  BUYER_API,
  type BuyerApiPolicy,
  type BuyerSellerChoice,
} from '@gyblos/protocol/buyer-api';
import type { BuyerApiKeyCommand } from '@gyblos/protocol/buyer-api-keys';
import {
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';

import { requestAgentEndpoint } from './agent-endpoint';
import { desktopBuyerFailure } from './buyer-error';
import { inspectDesktopChannel } from './funding/client';
import { requestBuyerApiKeys } from './usdc-api-client';
import { X402Budget } from './x402-budget';
import {
  assertFreeBudget,
  buyerConnection,
  buyerEndpoint,
  policyForRoute,
  policyForSeller,
  readJson,
  reconcileBuyerPool,
  sellerFields,
  validateChoice,
  waitForPaidBuyer,
  type DesktopSellerChoice,
} from './x402-http';
import { DESKTOP_X402, PaidSellerLimitError } from './x402-model';
import {
  buyerReplyMetrics,
  buyerResponseObject as object,
  parseBuyerReply,
} from './x402-reply';
import { readBuyerStream } from './x402-stream';

export { buyerEndpoint } from './x402-http';
export { parseBuyerReply } from './x402-reply';
export type { DesktopSellerChoice } from './x402-http';
export class X402Client {
  private connection: Awaited<ReturnType<typeof buyerConnection>> | null = null;
  private busy = false;
  private closed = false;
  private controller: AbortController | null = null;
  private requestId: string | null = null;
  private pending: Promise<unknown> | null = null;
  private readonly keyRequests = new Map<Promise<unknown>, AbortController>();
  constructor(
    readonly budget: X402Budget,
    private readonly request: typeof fetch = fetch,
  ) {}
  managed() {
    return this.connection?.managed === true;
  }
  policy() {
    return this.connection ? { ...this.connection.policy } : null;
  }
  assertPolicyChange(
    owner: { url: string; token: string } | undefined,
    policyId?: string,
  ) {
    if (this.busy || this.closed || this.keyRequests.size)
      throw new PaidSellerLimitError(
        'Wait for the current buyer request to finish.',
      );
    if (
      this.connection &&
      (!owner ||
        this.connection.token !== owner.token ||
        this.connection.url.href !== owner.url)
    )
      throw new PaidSellerLimitError(
        'Only the buyer managed by this app can be configured here.',
      );
    if (this.connection?.policy.policyId !== policyId)
      throw new PaidSellerLimitError(
        'The buyer changed. Select the seller again.',
      );
  }
  disconnectForPolicyChange(
    owner: { url: string; token: string } | undefined,
    policyId?: string,
  ) {
    this.assertPolicyChange(owner, policyId);
    this.disconnect();
  }
  disconnect() {
    for (const controller of this.keyRequests.values()) controller.abort();
    this.connection = null;
    this.controller?.abort();
  }
  async connect(input: unknown, token: unknown, managed = false) {
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
      this.connection = await buyerConnection(response, url, token, managed);
      return this.connection.policy;
    } finally {
      this.busy = false;
    }
  }
  canCheckChannels() {
    return this.connection?.reconcilesPool === true;
  }
  async reconcileReviewedPool(expected: BuyerApiPolicy) {
    const connection = this.connection;
    if (!connection?.reconcilesPool) return;
    await reconcileBuyerPool(connection, expected, this.request);
    if (this.connection !== connection) throw new Error('Unconfirmed payment');
  }
  inspectChannel(seller: BuyerSellerChoice) {
    const connection = this.connection;
    return inspectDesktopChannel(
      connection,
      seller,
      this.request,
      () => !this.closed && connection === this.connection,
    );
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
  stop(id: string) {
    if (
      this.requestId !== id ||
      !this.controller ||
      this.controller.signal.aborted
    )
      return false;
    this.controller.abort();
    return true;
  }
  send(
    id: string,
    prompt: string,
    onDelta?: (text: string) => void,
    choice?: DesktopSellerChoice,
    route?: NonNullable<BuyerApiPolicy['autoRoutes']>[number],
  ) {
    if (this.busy || this.closed || !this.connection)
      return Promise.reject(new Error('Local buyer is unavailable'));
    if (!prompt.trim() || Buffer.byteLength(prompt) > DESKTOP_X402.MAX_PROMPT)
      return Promise.reject(new Error('Message is empty or too large'));
    this.busy = true;
    const connection = this.connection;
    const controller = new AbortController();
    this.controller = controller;
    this.requestId = id;
    const work = this.execute(
      connection,
      id,
      prompt,
      controller.signal,
      onDelta,
      choice,
      route,
    );
    this.pending = work;
    return work.finally(() => {
      this.busy = false;
      this.controller = null;
      this.requestId = null;
      this.pending = null;
    });
  }
  private async execute(
    connection: NonNullable<X402Client['connection']>,
    id: string,
    prompt: string,
    external: AbortSignal,
    onDelta?: (text: string) => void,
    choice?: DesktopSellerChoice,
    route?: NonNullable<BuyerApiPolicy['autoRoutes']>[number],
  ) {
    const current = await this.budget.summary();
    external.throwIfAborted();
    if (choice === OFFER_PRICING_KINDS.FREE) {
      assertFreeBudget(current, id);
      return this.executeReserved(
        connection,
        id,
        prompt,
        { ...policyForRoute(connection.policy, route), maxAtomic: '0' },
        external,
        onDelta,
        choice,
      );
    }
    if (
      (current.active || !choice) &&
      current.policy?.policyId !== connection.policy.policyId
    )
      throw new Error(
        'Buyer policy changed. Finish the previous budget before authorizing another.',
      );
    const seller = typeof choice === 'object' ? choice : undefined;
    validateChoice(choice, connection.policy, current, route?.modelId);
    await waitForPaidBuyer(
      connection,
      this.request,
      external,
      seller?.expiresAt,
    );
    const intent =
      choice && connection.managed && this.budget.opening
        ? randomUUID()
        : undefined;
    const reserved = await this.budget.reserve(
      id,
      choice ? connection.policy : undefined,
      intent,
    );
    const policy = policyForRoute(
      policyForSeller(reserved, seller),
      route,
      choice === BUYER_API.AUTO,
    );
    let sent = false;
    try {
      external.throwIfAborted();
      sent = true;
      return await this.executeReserved(
        connection,
        id,
        prompt,
        policy,
        external,
        onDelta,
        choice,
        intent,
      );
    } catch (error) {
      if (intent) await this.budget.recoverOpening();
      else if (!sent) await this.budget.cancelUnsent(id);
      else if (
        policy.maxAtomic === '0' &&
        (await this.budget.summary()).blocked
      )
        await this.budget.releaseFree(id);
      throw error;
    }
  }
  private async executeReserved(
    connection: NonNullable<X402Client['connection']>,
    id: string,
    prompt: string,
    policy: BuyerApiPolicy,
    external: AbortSignal,
    onDelta?: (text: string) => void,
    choice?: DesktopSellerChoice,
    intent?: string,
  ) {
    const started = performance.now();
    const signal = AbortSignal.any([
      external,
      AbortSignal.timeout(DESKTOP_X402.REQUEST_MS),
    ]);
    signal.throwIfAborted();
    const response = await this.request(
      new URL(
        choice ? BUYER_API.CHANNEL_CHAT_PATH : BUYER_API.CHAT_PATH,
        connection.url,
      ),
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          authorization: 'Bearer ' + connection.token,
          'content-type': 'application/json',
          'if-match': '"' + policy.policyId + '"',
        },
        body: JSON.stringify({
          ...sellerFields(choice),
          ...(intent && { [BUYER_API.OPENING_INTENT_FIELD]: intent }),
          model: policy.model,
          messages: [{ role: FREE_CHAT_ROLES.USER, content: prompt }],
          max_tokens: policy.maxTokens,
          stream: !!onDelta,
        }),
      },
    );
    signal.throwIfAborted();
    const body =
      response.ok && onDelta
        ? await readBuyerStream(response, policy, signal, onDelta)
        : await readJson(response, true);
    signal.throwIfAborted();
    const responseMs = performance.now() - started;
    if (!response.ok) {
      const error = object(object(body).error);
      if (
        !intent &&
        choice !== OFFER_PRICING_KINDS.FREE &&
        error[BUYER_API.NEVER_SENT_FIELD] === true &&
        error.code !== PAID_BUYER_CODES.UNRESOLVED
      )
        await this.budget.cancelUnsent(id);
      throw desktopBuyerFailure(error, policy);
    }
    const reply = parseBuyerReply(body, policy);
    if (choice === OFFER_PRICING_KINDS.FREE && !reply.free)
      throw new Error('The seller did not return a free response.');
    if (
      choice &&
      choice !== OFFER_PRICING_KINDS.FREE &&
      !(choice === BUYER_API.AUTO && reply.free) &&
      !reply.sessionApproval
    )
      throw new Error('Missing channel approval');
    const summary =
      choice === OFFER_PRICING_KINDS.FREE
        ? await this.budget.recordFree(id, policy)
        : await this.budget.complete(
            id,
            reply,
            typeof choice === 'object' ? choice.modelId : undefined,
          );
    signal.throwIfAborted();
    const metrics = buyerReplyMetrics(reply, policy, responseMs);
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
