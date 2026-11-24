import { randomBytes } from 'node:crypto';

import { EndpointAddr, EndpointId, type Endpoint } from '@number0/iroh';

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { acceptControlQuote } from '@gyblos/core/control-quotes';
import {
  CONTROL_LIMITS,
  CONTROL_METHODS,
  CONTROL_VERSION,
  FREE_CHAT_ROLES,
  PUBLIC_RECORD_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import { parseControlQuery } from '@gyblos/protocol/control-requests';
import { matchControlResponse } from '@gyblos/protocol/control-response';
import type {
  ControlQuery,
  PublicModelV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import {
  controlAddress,
  controlArray,
  controlHex,
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';
import { buildFreeExecutionRequest } from '@gyblos/protocol/free-execution';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import {
  catalogDigestV2,
  validatePublicV2Time,
  verifyPublicV2,
} from '@gyblos/protocol/public-v2';
import { createControlTransport } from '@gyblos/transport-iroh/control-client';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';

import {
  MODEL_VERIFIER,
  MODEL_VERIFIER_CODES,
  ModelVerifierError,
} from './constants';

export interface SellerTarget {
  owner: string;
  nodeId: string;
  relayUrl: string | null;
  directAddresses: string[];
}

const MAX_DIRECT_ADDRESSES = 16;
const FREE_ATOMIC = '0';

export function parseSellerTarget(value: unknown): SellerTarget {
  try {
    const input = controlObject(value, [
      'owner',
      'nodeId',
      'relayUrl',
      'directAddresses',
    ]);
    return {
      owner: controlAddress(input.owner),
      nodeId: controlHex(input.nodeId),
      relayUrl: input.relayUrl === null ? null : controlText(input.relayUrl),
      directAddresses: controlArray(
        input.directAddresses,
        MAX_DIRECT_ADDRESSES,
      ).map((address) => controlText(address)),
    };
  } catch {
    throw invalidSeller();
  }
}

function relayAllowed(origin: string) {
  try {
    assertConfiguredRelay(origin);
    return true;
  } catch {
    return false;
  }
}

const requestId = () =>
  randomBytes(CONTROL_LIMITS.requestIdBytes).toString('hex');
const isFree = (model: PublicModelV2) =>
  model.pricing.inputAtomicPerMtok === FREE_ATOMIC &&
  model.pricing.outputAtomicPerMtok === FREE_ATOMIC &&
  model.reasoning.includes(REASONING_LEVELS.OFF);

type Exchange = (
  query: ControlQuery,
) => Promise<ReturnType<typeof matchControlResponse>>;
interface SellerTrust {
  owner: string;
  nodeId: string;
  relayAllowed: (origin: string) => boolean;
}
const invalidSeller = () =>
  new ModelVerifierError(MODEL_VERIFIER_CODES.INVALID_SELLER);

async function freeListing(
  exchange: Exchange,
  trust: SellerTrust,
  modelId: string,
) {
  const answer = await exchange({
    version: CONTROL_VERSION,
    requestId: requestId(),
    method: CONTROL_METHODS.CATALOG,
    params: {},
  });
  if (answer.method !== CONTROL_METHODS.CATALOG) throw invalidSeller();
  const record = await verifyPublicV2(answer.catalog, {
    ...trust,
    now: Date.now(),
  });
  validatePublicV2Time(record, Date.now());
  if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG) throw invalidSeller();
  const listing = record.models.find(
    (model) => model.modelId === modelId && isFree(model),
  );
  if (!listing)
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.NO_FREE_OFFER);
  const catalog: SignedPublicV2 = {
    record,
    signature: answer.catalog.signature,
  };
  return { listing, catalog, catalogDigest: await catalogDigestV2(record) };
}

async function freeQuote(
  exchange: Exchange,
  trust: SellerTrust,
  offered: Awaited<ReturnType<typeof freeListing>>,
  buyer: { address: string; nodeId: string },
  maxTokens: number,
) {
  const { listing, catalog, catalogDigest } = offered;
  const query = parseControlQuery({
    version: CONTROL_VERSION,
    requestId: requestId(),
    method: CONTROL_METHODS.OFFER,
    params: {
      buyer: buyer.address,
      buyerNodeId: buyer.nodeId,
      selection: selectionOf(listing),
      reasoning: REASONING_LEVELS.OFF,
      maxTokens,
      maxAtomic: FREE_ATOMIC,
      priceCeilings: {
        inputAtomicPerMtok: FREE_ATOMIC,
        outputAtomicPerMtok: FREE_ATOMIC,
      },
      network: listing.pricing.network,
      asset: listing.pricing.asset,
      catalogDigest,
    },
  });
  const offer = await exchange(query);
  if (offer.method !== CONTROL_METHODS.OFFER) throw invalidSeller();
  const accepted = await acceptControlQuote(offer.offer, query, {
    ...trust,
    now: Date.now(),
    catalog,
  });
  validateOfferV2Time(accepted, Date.now());
  return offer.offer;
}

const selectionOf = (listing: PublicModelV2) => ({
  modelId: listing.modelId,
  variant: listing.variant,
  quantization: listing.quantization,
});

export async function openSeller(
  endpoint: Endpoint,
  target: SellerTarget,
  address: string,
  modelId: string,
) {
  if (target.relayUrl && !relayAllowed(target.relayUrl)) throw invalidSeller();
  const remote = new EndpointAddr(
    EndpointId.fromString(target.nodeId),
    target.relayUrl ?? undefined,
    target.directAddresses,
  );
  const trust = { owner: target.owner, nodeId: target.nodeId, relayAllowed };
  const transport = createControlTransport(endpoint, remote, target.nodeId, {
    queryMs: CONTROL_CAPACITY.queryMs,
  });
  const exchange: Exchange = async (query) =>
    matchControlResponse(await transport.exchange(query), query);
  const buyer = { address, nodeId: endpoint.id().toString() };
  try {
    const offered = await freeListing(exchange, trust, modelId);
    return {
      selection: selectionOf(offered.listing),
      async ask(prompt: string, maxTokens: number) {
        const quote = await freeQuote(
          exchange,
          trust,
          offered,
          buyer,
          maxTokens,
        );
        const request = buildFreeExecutionRequest(quote, {
          messages: [{ role: FREE_CHAT_ROLES.USER, content: prompt }],
          maxTokens,
        });
        const client = createFreeExecutionClient(endpoint, remote, trust, {
          requestMs: MODEL_VERIFIER.answerTimeoutMs,
          relayAllowed,
        });
        try {
          return (await client.execute(request)).text;
        } finally {
          client.close();
          await client.settled();
        }
      },
      async close() {
        await transport.close();
        await transport.settled();
      },
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
}
