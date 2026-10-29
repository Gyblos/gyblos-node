// Bounds receipt RPC lifetime and concurrency; no automatic retry, endpoint ownership or execution policy.

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { RECEIPT_CHANNEL_CODES } from '@gyblos/protocol/constants';
import { controlInteger } from '@gyblos/protocol/control-validation';
import {
  parseReceiptChannelRequest,
  ReceiptChannelError,
  receiptChannelError,
} from '@gyblos/protocol/receipt-channel';

import { controlDeadline } from './control-io';
import { createReceiptSession } from './receipt-client-session';
import type {
  ReceiptDestination,
  ReceiptEndpoint,
} from './receipt-client-types';
import type { ReceiptClientOptions } from './receipt-client-validation';

export type { ReceiptClientOptions } from './receipt-client-validation';

export type {
  ReceiptConnection,
  ReceiptDestination,
  ReceiptEndpoint,
} from './receipt-client-types';

export function createReceiptTransport<Remote extends ReceiptDestination>(
  endpoint: ReceiptEndpoint<Remote>,
  remote: Remote,
  expectedNodeId: string,
  options: ReceiptClientOptions = {},
) {
  const queryMs = controlInteger(
    options.queryMs ?? CONTROL_CAPACITY.queryMs,
    1,
    CONTROL_CAPACITY.queryMs,
  );
  const session = createReceiptSession(endpoint, remote, expectedNodeId, {
    ...options,
  });
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let busy = false;
  return {
    async exchange(value: unknown, external?: AbortSignal) {
      if (busy) throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BUSY);
      const request = parseReceiptChannelRequest(value);
      const signal = external
        ? AbortSignal.any([external, lifetime.signal])
        : lifetime.signal;
      if (signal.aborted)
        throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.CANCELLED);
      busy = true;
      try {
        return await controlDeadline(
          (deadline) => {
            const operation = session.exchange(request, deadline);
            pending.add(operation);
            void operation
              .then(
                () => pending.delete(operation),
                () => pending.delete(operation),
              )
              .finally(() => {
                busy = false;
              });
            return operation;
          },
          queryMs,
          session.close,
          signal,
        );
      } catch (error) {
        session.close();
        throw receiptChannelError(error);
      }
    },
    async close() {
      lifetime.abort();
      session.close();
    },
    async settled() {
      await Promise.allSettled(pending);
    },
  };
}
