import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_STATUS } from '@gyblos/config';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

import type { buyerApiKeyExecutors } from './api-key-execution';
import { FREE_BUYER_CODES } from './constants';
import { FreeBuyerError } from './free-chat-error';
import type { ChatExecutors } from './free-http';
import type { executionSlots } from './session-serial';

type Pending = Map<string, () => boolean>;
export function queuedRequest(request: IncomingMessage, pending: Pending) {
  const id = request.headers[BUYER_API.QUEUE_ID_HEADER];
  if (typeof id !== 'string' || !BUYER_API.POLICY_PATTERN.test(id)) return;
  let waitingForSeller = false;
  return {
    id,
    sellerWait: (waiting: boolean) => {
      waitingForSeller = waiting;
    },
    register: (entered: () => boolean, controller: AbortController) =>
      pending.set(id, () => {
        if ((entered() && !waitingForSeller) || controller.signal.aborted)
          return false;
        controller.abort(new FreeBuyerError(FREE_BUYER_CODES.CANCELLED));
        return true;
      }),
    close: () => pending.delete(id),
  };
}
export function cancelQueuedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  owner: boolean,
  policy: BuyerApiPolicy | undefined,
  pending: Pending,
) {
  if (request.url !== BUYER_API.CANCEL_QUEUED_PATH) return false;
  const queue = queuedRequest(request, pending);
  const stopped =
    owner &&
    policy &&
    queue &&
    request.method === 'POST' &&
    request.headers.origin === undefined &&
    request.headers['if-match'] === '"' + policy.policyId + '"' &&
    request.headers['transfer-encoding'] === undefined &&
    Number(request.headers['content-length'] ?? 0) === 0 &&
    pending.get(queue.id)?.();
  response
    .writeHead(stopped ? HTTP_STATUS.noContent : HTTP_STATUS.forbidden, {
      'cache-control': 'no-store',
    })
    .end();
  return true;
}
export function scheduledExecutors(
  schedule: ReturnType<typeof executionSlots>,
  { execute, stream }: ReturnType<typeof buyerApiKeyExecutors>,
) {
  let entered = false;
  let queued = false;
  const enter = <T>(signal: AbortSignal, run: () => Promise<T>) => {
    queued = true;
    return schedule(signal, () => {
      entered = true;
      queued = false;
      return run();
    });
  };
  return {
    entered: () => entered,
    queued: () => queued,
    execute: (input, signal, delta, model) =>
      enter(signal, () => execute(input, signal, delta, model)),
    stream:
      stream &&
      ((input, signal, delta, model) =>
        enter(signal, () => stream(input, signal, delta, model))),
  } satisfies ChatExecutors & { queued(): boolean; entered(): boolean };
}
