// Authenticates a new channel's terms before the buyer commits a journal slot or deposit.
import { randomBytes } from 'node:crypto';

import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  BatchChannelError,
  batchFail,
  matchBatchTerms,
  verifyBatchQuote,
} from '@gyblos/protocol/batch-channel';
import { CONTROL_METERING_MODES } from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  PAYMENT_SESSION,
  PaymentSessionError,
  SESSION_CODES,
  UnsentChannelLimitError,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';
import {
  BatchClientError,
  createBatchChannelClient,
  type BatchDestination,
} from '@gyblos/transport-iroh/batch-client';

import { UnsentSellerBusyError } from './buyer-routing';
import type { BuyerSessionOptions } from './buyer-session';

export class UnsentChannelRequestError extends Error {
  readonly code: BatchChannelError['code'];
  constructor(
    readonly nodeId: string,
    cause: unknown,
  ) {
    super('Channel request was not sent', { cause });
    this.code =
      cause instanceof BatchChannelError || cause instanceof PaymentSessionError
        ? cause.code
        : SESSION_CODES.UNAVAILABLE;
  }
}

export async function withChannelAuthorization<T>(
  authorize: BuyerSessionOptions<BatchDestination>['authorizeRequest'],
  quote: SignedOfferV2,
  signal: AbortSignal,
  start: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (authorize) {
    const release = await authorize(quote, signal);
    if (signal.aborted) {
      await release?.().catch(() => undefined);
      signal.throwIfAborted();
    }
  }
  return start();
}

export type StartChannelWork = <T>(work: () => Promise<T>) => Promise<T>;

export function channelTurnAuthority(
  authorize: BuyerSessionOptions<BatchDestination>['authorizeRequest'],
  quote: SignedOfferV2,
  signal: AbortSignal,
) {
  let started = false;
  let pending: Promise<void> | undefined;
  const start: StartChannelWork = (work) => {
    signal.throwIfAborted();
    if (started || !authorize) return work();
    let finishWrite!: () => void;
    pending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    return withChannelAuthorization(authorize, quote, signal, () => {
      started = true;
      finishWrite();
      return work();
    }).finally(finishWrite);
  };
  return { start, settled: () => pending };
}

export async function verifyUnsentPoolQuote(
  quote: SignedOfferV2,
  terms: PaymentSessionTerms,
  peer: string,
  now: number,
) {
  try {
    return await verifyBatchQuote(quote, terms, peer, now);
  } catch (error) {
    if (
      error instanceof BatchChannelError &&
      !error.remote &&
      error.code === SESSION_CODES.LIMIT
    )
      throw new UnsentChannelLimitError(quote.offer.nodeId);
    throw error;
  }
}

export class UnsentChannelPeerError extends BatchChannelError {
  constructor(readonly nodeId: string) {
    super(PAID_EXECUTION_CODES.PEER);
  }
}
export type PreparedChannel = Awaited<ReturnType<typeof prepareNewChannel>>;
export async function prepareNewChannel<Remote extends BatchDestination>(
  options: Pick<
    BuyerSessionOptions<Remote>,
    | 'endpoint'
    | 'destination'
    | 'transport'
    | 'meter'
    | 'now'
    | 'openingSupportsBlocks'
  >,
  quote: SignedOfferV2,
  terms: PaymentSessionTerms,
  signal: AbortSignal,
) {
  // Blocks certify prefixes with the model's tokenizer; a declared offer has none, so it prepares without.
  const blocks =
    options.openingSupportsBlocks === true &&
    typeof options.meter.stablePrefix === 'function' &&
    quote.offer.meteringMode !== CONTROL_METERING_MODES.DECLARED;
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
