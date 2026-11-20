// Authenticates a new channel's terms before the buyer commits a journal slot or deposit.
import { randomBytes } from 'node:crypto';

import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  BatchChannelError,
  batchFail,
  matchBatchTerms,
} from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';
import {
  BatchClientError,
  createBatchChannelClient,
  type BatchDestination,
} from '@gyblos/transport-iroh/batch-client';

import { UnsentSellerBusyError } from './buyer-routing';
import type { BuyerSessionOptions } from './buyer-session';

export class UnsentChannelPeerError extends BatchChannelError {
  constructor(readonly nodeId: string) {
    super(PAID_EXECUTION_CODES.PEER);
  }
}
export type PreparedChannel = Awaited<ReturnType<typeof prepareNewChannel>>;
export async function prepareNewChannel<Remote extends BatchDestination>(
  options: Pick<
    BuyerSessionOptions<Remote>,
    'endpoint' | 'destination' | 'transport' | 'meter' | 'now'
  >,
  quote: SignedOfferV2,
  terms: PaymentSessionTerms,
  signal: AbortSignal,
) {
  const blocks = typeof options.meter.stablePrefix === 'function';
  const client = createBatchChannelClient(
    options.endpoint,
    options.destination(terms),
    terms.sellerNodeId,
    { ...options.transport, now: options.now, blocks },
  );
  try {
    const reply = await client.exchange(
      {
        version: BATCH_CHANNEL.version,
        method: BATCH_METHODS.PREPARE,
        requestId: randomBytes(PAYMENT_SESSION.requestIdBytes).toString('hex'),
        params: { quote, terms },
      },
      signal,
    );
    if (!reply.result || !('terms' in reply.result))
      return batchFail(SESSION_CODES.BINDING);
    matchBatchTerms(reply.result.terms, terms);
    const signature = quote.signature;
    const binding = canonicalJson(terms);
    let used = false;
    return {
      consume(
        current: SignedOfferV2,
        proposed: PaymentSessionTerms,
        blockMode: boolean,
      ) {
        if (
          used ||
          current.signature !== signature ||
          canonicalJson(proposed) !== binding ||
          blockMode !== blocks
        )
          return false;
        used = true;
        return true;
      },
    };
  } catch (error) {
    if (error instanceof BatchClientError) {
      if (error.code === PAID_EXECUTION_CODES.PEER)
        throw new UnsentChannelPeerError(terms.sellerNodeId);
      if (
        error.remote &&
        (error.code === SESSION_CODES.BUSY ||
          error.code === PAID_EXECUTION_CODES.BUSY)
      )
        throw new UnsentSellerBusyError(terms.sellerNodeId);
    }
    throw error;
  } finally {
    await client.close();
    await client.settled();
  }
}
