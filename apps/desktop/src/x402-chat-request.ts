import { randomUUID } from 'node:crypto';

import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';

import {
  cancelQueuedChat,
  chatHeaders,
  sellerFields,
  type buyerConnection,
  type DesktopSellerChoice,
} from './x402-http';

export class DesktopChatRequest extends AbortController {
  private cancelQueued?: () => Promise<boolean>;
  confirmed?: Promise<boolean>;
  stop() {
    if (this.signal.aborted || this.confirmed) return false;
    if (this.cancelQueued) {
      this.confirmed = this.cancelQueued().catch(() => false);
      void this.confirmed.then(() => this.abort());
    } else this.abort();
    return true;
  }
  async post(
    connection: Awaited<ReturnType<typeof buyerConnection>>,
    request: typeof fetch,
    policy: BuyerApiPolicy,
    prompt: string,
    stream: boolean,
    choice: DesktopSellerChoice | undefined,
    intent: string | undefined,
    explicitFree: boolean | undefined,
    signal: AbortSignal,
  ) {
    const queueId =
      connection.cancelsQueued && choice && choice !== OFFER_PRICING_KINDS.FREE
        ? randomUUID()
        : undefined;
    const headers = chatHeaders(
      connection.token,
      policy.policyId,
      explicitFree,
    );
    if (queueId)
      this.cancelQueued = () => cancelQueuedChat(connection, request, queueId);
    const response = await request(
      new URL(
        choice ? BUYER_API.CHANNEL_CHAT_PATH : BUYER_API.CHAT_PATH,
        connection.url,
      ),
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          ...headers,
          ...(queueId && { [BUYER_API.QUEUE_ID_HEADER]: queueId }),
        },
        body: JSON.stringify({
          ...sellerFields(choice),
          ...(intent && { [BUYER_API.OPENING_INTENT_FIELD]: intent }),
          model: policy.model,
          messages: [{ role: FREE_CHAT_ROLES.USER, content: prompt }],
          max_tokens: policy.maxTokens,
          stream,
        }),
      },
    );
    this.cancelQueued = undefined;
    return response;
  }
}
