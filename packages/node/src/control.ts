// Composes pure control policy with cached catalog/readiness and unfunded signing callbacks.
// This service has no engine, payment, filesystem or journal dependency.
import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { ControlAdmission } from '@gyblos/core/control-admission';
import {
  createControlQuote,
  type QuoteContext,
} from '@gyblos/core/control-quotes';
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_METHODS,
  CONTROL_RECORD_VERSION,
  CONTROL_VERSION,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import { parseControlQuery } from '@gyblos/protocol/control-requests';
import type {
  ControlQuery,
  ControlResponse,
  PublicCatalogV2,
} from '@gyblos/protocol/control-types';
import {
  ControlError,
  controlFail,
  controlHex,
} from '@gyblos/protocol/control-validation';
import {
  catalogDigestV2,
  signPublicV2,
  validatePublicV2Time,
  verifyPublicV2,
} from '@gyblos/protocol/public-v2';
import type { Signer } from '@gyblos/protocol/signing';
import type { ControlService } from '@gyblos/transport-iroh/control-server';

import {
  quoteModel,
  sameSelection,
  type ControlOffers,
} from './control-offers';
import type { SellerPublicRecords } from './public-records';

export interface SellerControlOptions {
  context: Omit<QuoteContext, 'remoteNodeId' | 'signal'>;
  ownerSigner: Signer;
  nodeSigner: Signer;
  monotonic?: () => number;
  records?: SellerPublicRecords;
  // The seller's listed offers, read per query: they replace the context's models, and each quote is
  // bound to its own offer's readiness instead of the catalog's.
  offers?: Pick<ControlOffers, 'listed'>;
}

export function createSellerControlService(
  options: SellerControlOptions,
): ControlService {
  const admission = admissionFor(options.monotonic);
  let sequence = options.context.catalog.record.sequence;
  return {
    queryMs: CONTROL_CAPACITY.queryMs,
    idleMs: CONTROL_CAPACITY.connectionIdleMs,
    open: (peer) => admission.openConnection(peer),
    async respond(value, peer, signal): Promise<ControlResponse> {
      const requestId = validatedRequestId(value);
      try {
        const query = parseControlQuery(value);
        const context = queryContext(options, query);
        if (signal.aborted) return controlFail(CONTROL_CODES.CANCELLED);
        if (query.method === CONTROL_METHODS.OFFER) {
          const offer = await createControlQuote(
            query,
            { ...context, remoteNodeId: peer, signal },
            options.ownerSigner,
          );
          if (options.records && options.records.current() !== context.catalog)
            return controlFail(CONTROL_CODES.STALE);
          return {
            version: CONTROL_VERSION,
            requestId,
            result: { method: query.method, offer },
          };
        }
        const record = await verifiedCatalog(context, signal);
        if (options.records && options.records.current() !== context.catalog)
          return controlFail(CONTROL_CODES.STALE);
        const now = context.now();
        if (query.method === CONTROL_METHODS.CATALOG)
          return {
            version: CONTROL_VERSION,
            requestId,
            result: {
              method: query.method,
              catalog: { record, signature: context.catalog.signature },
            },
          };
        if (!options.records)
          sequence = Math.max(sequence, record.sequence) + 1;
        const presence = await currentPresence(
          options,
          context,
          record,
          sequence,
          now,
          signal,
        );
        assertUncancelled(signal);
        if (options.records && options.records.current() !== context.catalog)
          return controlFail(CONTROL_CODES.STALE);
        validatePublicV2Time(presence.record, context.now());
        return {
          version: CONTROL_VERSION,
          requestId,
          result: { method: CONTROL_METHODS.PRESENCE, presence },
        };
      } catch (error) {
        return {
          version: CONTROL_VERSION,
          requestId,
          error: {
            code:
              error instanceof ControlError
                ? error.code
                : CONTROL_CODES.INTERNAL,
          },
        };
      }
    },
  };
}

// The listed offers, read once per query, replace the context's models; a quote is bound to its own
// offer's readiness. An unlisted selection keeps the catalog's, and the catalog refuses it as MODEL first.
function queryContext(options: SellerControlOptions, query: ControlQuery) {
  const listed = options.offers?.listed();
  const own =
    query.method === CONTROL_METHODS.OFFER &&
    listed?.find((offer) =>
      sameSelection(offer.selection, query.params.selection),
    );
  return {
    ...options.context,
    catalog: options.records?.current() ?? options.context.catalog,
    ...(listed ? { models: listed.map(quoteModel) } : {}),
    ...(own ? { readiness: own.readiness } : {}),
  };
}

async function currentPresence(
  options: SellerControlOptions,
  context: Omit<QuoteContext, 'remoteNodeId' | 'signal'>,
  record: PublicCatalogV2,
  sequence: number,
  now: number,
  signal: AbortSignal,
) {
  return options.records
    ? options.records.presence(signal)
    : signPresence(context, record, sequence, now, async (bytes) => {
        assertUncancelled(signal);
        return options.nodeSigner(bytes);
      });
}
async function verifiedCatalog(
  context: Omit<QuoteContext, 'remoteNodeId' | 'signal'>,
  signal: AbortSignal,
) {
  const record = await verifyPublicV2(context.catalog, {
    owner: context.owner,
    nodeId: context.nodeId,
    now: context.now(),
  });
  assertUncancelled(signal);
  if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG) return controlFail();
  validatePublicV2Time(record, context.now());
  return record;
}
function assertUncancelled(signal: AbortSignal) {
  if (signal.aborted) return controlFail(CONTROL_CODES.CANCELLED);
}

async function signPresence(
  context: Omit<QuoteContext, 'remoteNodeId' | 'signal'>,
  record: PublicCatalogV2,
  sequence: number,
  now: number,
  signer: Signer,
) {
  return signPublicV2(
    {
      schemaVersion: CONTROL_RECORD_VERSION,
      kind: PUBLIC_RECORD_KINDS.PRESENCE,
      owner: context.owner,
      nodeId: context.nodeId,
      sequence,
      issuedAt: now,
      expiresAt: Math.min(
        record.expiresAt,
        now + PUBLIC_RECORD_LIMITS.presenceLifetimeMs,
      ),
      catalogDigest: await catalogDigestV2(record),
      state: PUBLIC_PRESENCE_STATE,
    },
    signer,
  );
}

function validatedRequestId(value: unknown) {
  return controlHex(
    value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'requestId')?.value
      : undefined,
    CONTROL_LIMITS.requestIdBytes,
  );
}

function admissionFor(monotonic?: () => number) {
  return new ControlAdmission(monotonic ?? (() => performance.now()));
}
