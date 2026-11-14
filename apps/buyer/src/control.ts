// Queries one independently trusted seller, authenticating public snapshots and private quotes.
// Seller selection, payment admission and the buyer proxy are outside this client.
import { randomBytes } from 'node:crypto';

import type { Endpoint, EndpointAddr } from '@number0/iroh';

import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { acceptControlQuote } from '@gyblos/core/control-quotes';
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_METHODS,
  CONTROL_VERSION,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';
import { parseControlQuery } from '@gyblos/protocol/control-requests';
import { matchControlResponse } from '@gyblos/protocol/control-response';
import type {
  ControlOfferParams,
  ControlQuery,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import { controlFail } from '@gyblos/protocol/control-validation';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import {
  catalogDigestV2,
  validatePublicV2Time,
  verifyPublicV2,
} from '@gyblos/protocol/public-v2';
import {
  createControlTransport,
  type ControlTransport,
} from '@gyblos/transport-iroh/control-client';

export interface ControlSellerTrust {
  owner: string;
  nodeId: string;
  relayAllowed: (origin: string) => boolean;
  now?: () => number;
}
function requestId() {
  return randomBytes(CONTROL_LIMITS.requestIdBytes).toString('hex');
}
class BuyerControlClient {
  private catalog: SignedPublicV2 | undefined;
  private presenceSequence = -1;
  private readonly now: () => number;
  constructor(
    private readonly transport: ControlTransport,
    private readonly trust: ControlSellerTrust,
  ) {
    this.now = trust.now ?? Date.now;
    if (transport.remoteNodeId !== trust.nodeId)
      return controlFail(CONTROL_CODES.POLICY);
  }
  private async exchange(query: ControlQuery, signal?: AbortSignal) {
    return matchControlResponse(
      await this.transport.exchange(query, signal),
      query,
    );
  }
  async getCatalog(signal?: AbortSignal) {
    const result = await this.exchange(
      {
        version: CONTROL_VERSION,
        requestId: requestId(),
        method: CONTROL_METHODS.CATALOG,
        params: {},
      },
      signal,
    );
    if (result.method !== CONTROL_METHODS.CATALOG) return controlFail();
    const record = await verifyPublicV2(result.catalog, {
      ...this.trust,
      now: this.now(),
    });
    if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG) return controlFail();
    validatePublicV2Time(record, this.now());
    if (this.catalog) {
      if (record.sequence < this.catalog.record.sequence)
        return controlFail(CONTROL_CODES.STALE);
      if (
        record.sequence === this.catalog.record.sequence &&
        (await catalogDigestV2(record)) !==
          (await catalogDigestV2(this.catalog.record))
      )
        return controlFail(CONTROL_CODES.STALE);
    }
    this.catalog = { record, signature: result.catalog.signature };
    return this.catalog;
  }
  // A catalog this buyer verified earlier from the same seller (selection-cache.ts), so a quote binds to
  // it without asking again. Checked like a fetched one; a seller that changed it refuses the quote.
  async useCatalog(signed: SignedPublicV2) {
    const record = await verifyPublicV2(signed, {
      ...this.trust,
      now: this.now(),
    });
    if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG) return controlFail();
    validatePublicV2Time(record, this.now());
    this.catalog ??= { record, signature: signed.signature };
  }
  async getPresence(signal?: AbortSignal) {
    if (!this.catalog) await this.getCatalog(signal);
    const current = this.catalog!;
    if (current.record.kind !== PUBLIC_RECORD_KINDS.CATALOG)
      return controlFail();
    const result = await this.exchange(
      {
        version: CONTROL_VERSION,
        requestId: requestId(),
        method: CONTROL_METHODS.PRESENCE,
        params: {},
      },
      signal,
    );
    if (result.method !== CONTROL_METHODS.PRESENCE) return controlFail();
    const record = await verifyPublicV2(result.presence, {
      ...this.trust,
      now: this.now(),
      catalog: current.record,
    });
    if (
      record.kind !== PUBLIC_RECORD_KINDS.PRESENCE ||
      record.sequence <= this.presenceSequence
    )
      return controlFail(CONTROL_CODES.STALE);
    validatePublicV2Time(record, this.now());
    this.presenceSequence = record.sequence;
    return { record, signature: result.presence.signature };
  }
  async requestOffer(
    params: Omit<ControlOfferParams, 'buyerNodeId' | 'catalogDigest'>,
    signal?: AbortSignal,
  ) {
    if (!this.catalog) await this.getCatalog(signal);
    const current = this.catalog!;
    const query = parseControlQuery({
      version: CONTROL_VERSION,
      requestId: requestId(),
      method: CONTROL_METHODS.OFFER,
      params: {
        ...params,
        buyerNodeId: this.transport.localNodeId,
        catalogDigest: await catalogDigestV2(current.record),
      },
    });
    const result = await this.exchange(query, signal);
    if (result.method !== CONTROL_METHODS.OFFER) return controlFail();
    const offer = await acceptControlQuote(result.offer, query, {
      ...this.trust,
      now: this.now(),
      catalog: current,
    });
    validateOfferV2Time(offer, this.now());
    return result.offer;
  }
  close() {
    return this.transport.close();
  }
  async settled() {
    await this.transport.settled?.();
  }
}
export function createBuyerControlClient(
  transport: ControlTransport,
  trust: ControlSellerTrust,
) {
  return new BuyerControlClient(transport, { ...trust });
}
export async function connectBuyerControl(
  endpoint: Endpoint,
  remote: EndpointAddr,
  trust: ControlSellerTrust,
  relayOnly = false,
) {
  const { EndpointAddr } = await import('@number0/iroh');
  const relay = remote.relayUrl();
  if (
    remote.id().toString() !== trust.nodeId ||
    (relay && !trust.relayAllowed(relay))
  )
    return controlFail(CONTROL_CODES.POLICY);
  if (
    relayOnly &&
    (!relay ||
      endpoint
        .boundSockets()
        .some(
          (socket) =>
            !socket.startsWith(`${LOCALHOST}:`) &&
            !socket.startsWith(`${IPV6_LOOPBACK}:`),
        ))
  )
    return controlFail(CONTROL_CODES.POLICY);
  const address = new EndpointAddr(
    remote.id(),
    relay,
    relayOnly ? [] : remote.directAddresses(),
  );
  return createBuyerControlClient(
    createControlTransport(endpoint, address, trust.nodeId, {
      queryMs: CONTROL_CAPACITY.queryMs,
      relayOnly,
    }),
    trust,
  );
}
