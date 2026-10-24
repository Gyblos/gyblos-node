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

import type { SellerPublicRecords } from './public-records.js';

export interface SellerControlOptions {
  context: Omit<QuoteContext, 'remoteNodeId' | 'signal'>;
  ownerSigner: Signer;
  nodeSigner: Signer;
  monotonic?: () => number;
  records?: SellerPublicRecords;
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
        const context = {
          ...options.context,
          catalog: options.records?.current() ?? options.context.catalog,
        };
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
        const now = context.now();
        const record = await verifyPublicV2(context.catalog, {
          owner: context.owner,
          nodeId: context.nodeId,
          now,
        });
        if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG) return controlFail();
        validatePublicV2Time(record, context.now());
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
        );
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

async function currentPresence(
  options: Parameters<typeof createSellerControlService>[0],
  context: Omit<QuoteContext, 'remoteNodeId' | 'signal'>,
  record: PublicCatalogV2,
  sequence: number,
  now: number,
) {
  return options.records
    ? options.records.presence()
    : signPresence(context, record, sequence, now, options.nodeSigner);
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
