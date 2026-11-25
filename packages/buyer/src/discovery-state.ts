// Owns monotonic v2 replay metadata for independently verified discovery/control observations.
// Metadata is only a candidate hint: it must never substitute for signed Iroh verification.
import { createHash } from 'node:crypto';

import type { KnownSeller } from '@gyblos/core/seller-selection';
import { PUBLIC_V2_DOMAINS } from '@gyblos/protocol/constants';
import {
  controlAddress,
  controlHex,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';
import { signingBytes } from '@gyblos/protocol/signing';

import { BUYER_SELECTION_CODES } from './constants';
import { BuyerSelectionError } from './selection-config';

export interface DiscoveryRow {
  owner: string;
  nodeId: string;
  highWater: number;
  catalogSequence: number;
  catalogDigest: string;
  catalogExpiresAt: number;
  presenceDigest: string;
  presenceExpiresAt: number;
  withdrawnThrough: number;
  conflictedThrough: number;
}
export async function discoveryObservation(
  seller: KnownSeller,
): Promise<DiscoveryRow> {
  const { catalog, presence, withdrawal } = seller;
  if (!presence)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.DISCOVERY_STATE);
  return {
    owner: catalog.owner,
    nodeId: catalog.nodeId,
    highWater: Math.max(presence.sequence, withdrawal?.sequence ?? 0),
    catalogSequence: catalog.sequence,
    catalogDigest: await catalogDigestV2(catalog),
    catalogExpiresAt: catalog.expiresAt,
    presenceDigest: createHash('sha256')
      .update(signingBytes(PUBLIC_V2_DOMAINS[presence.kind], presence))
      .digest('hex'),
    presenceExpiresAt: presence.expiresAt,
    withdrawnThrough: withdrawal?.sequence ?? 0,
    conflictedThrough: 0,
  };
}
export function parseDiscoveryRow(value: unknown): DiscoveryRow {
  const row = controlObject(value, [
    'owner',
    'nodeId',
    'highWater',
    'catalogSequence',
    'catalogDigest',
    'catalogExpiresAt',
    'presenceDigest',
    'presenceExpiresAt',
    'withdrawnThrough',
    'conflictedThrough',
  ]);
  const result: DiscoveryRow = {
    owner: controlAddress(row.owner),
    nodeId: controlHex(row.nodeId),
    highWater: controlInteger(row.highWater),
    catalogSequence: controlInteger(row.catalogSequence, 1),
    catalogDigest: controlHex(row.catalogDigest),
    catalogExpiresAt: controlInteger(row.catalogExpiresAt),
    presenceDigest: controlHex(row.presenceDigest),
    presenceExpiresAt: controlInteger(row.presenceExpiresAt),
    withdrawnThrough: controlInteger(row.withdrawnThrough),
    conflictedThrough: controlInteger(row.conflictedThrough),
  };
  if (
    result.highWater <= result.catalogSequence ||
    result.withdrawnThrough > result.highWater ||
    result.conflictedThrough > result.highWater ||
    result.presenceExpiresAt > result.catalogExpiresAt
  )
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.DISCOVERY_STATE);
  return result;
}
export function discoveryRowLive(row: DiscoveryRow, now: number) {
  return (
    row.catalogExpiresAt > now && row.presenceExpiresAt > now && unblocked(row)
  );
}
export function mergeDiscoveryRow(
  held: DiscoveryRow | undefined,
  incoming: DiscoveryRow,
  allowOwnerChange = false,
): { row: DiscoveryRow; accepted: boolean } {
  if (!held)
    return {
      row: incoming,
      accepted: unblocked(incoming),
    };
  if (held.owner !== incoming.owner)
    return rotateDiscoveryOwner(held, incoming, allowOwnerChange);
  if (incoming.catalogSequence < held.catalogSequence)
    return {
      row:
        incoming.highWater > held.highWater
          ? {
              ...held,
              highWater: incoming.highWater,
              conflictedThrough: Math.max(
                held.conflictedThrough,
                incoming.highWater,
              ),
            }
          : held,
      accepted: false,
    };
  const catalogFork =
    incoming.catalogSequence === held.catalogSequence &&
    incoming.catalogDigest !== held.catalogDigest;
  const presenceFork =
    incoming.highWater === held.highWater &&
    incoming.catalogSequence === held.catalogSequence &&
    incoming.presenceDigest !== held.presenceDigest;
  if (catalogFork || presenceFork)
    return {
      row: {
        ...held,
        highWater: Math.max(held.highWater, incoming.highWater),
        conflictedThrough: Math.max(
          held.conflictedThrough,
          held.highWater,
          incoming.highWater,
        ),
      },
      accepted: false,
    };
  const withdrawnThrough = Math.max(
    held.withdrawnThrough,
    incoming.withdrawnThrough,
  );
  if (
    incoming.catalogSequence > held.catalogSequence &&
    incoming.catalogSequence <= held.highWater
  )
    return {
      row: {
        ...held,
        withdrawnThrough,
        highWater: Math.max(held.highWater, incoming.highWater),
        conflictedThrough: Math.max(held.conflictedThrough, incoming.highWater),
      },
      accepted: false,
    };
  if (incoming.highWater < held.highWater)
    return { row: { ...held, withdrawnThrough }, accepted: false };
  const row = {
    ...incoming,
    withdrawnThrough,
    conflictedThrough: held.conflictedThrough,
  };
  return {
    row,
    accepted: unblocked(row),
  };
}

function unblocked(row: DiscoveryRow) {
  // A withdrawal/conflict must be newer than a nonnegative catalog sequence; zero means absent.
  const through = Math.max(row.withdrawnThrough, row.conflictedThrough);
  return through === 0 || row.catalogSequence > through;
}

function rotateDiscoveryOwner(
  held: DiscoveryRow,
  incoming: DiscoveryRow,
  allowOwnerChange: boolean,
): { row: DiscoveryRow; accepted: boolean } {
  if (!allowOwnerChange || incoming.catalogSequence <= held.highWater)
    return { row: held, accepted: false };
  const row = {
    ...incoming,
    withdrawnThrough: Math.max(
      held.withdrawnThrough,
      incoming.withdrawnThrough,
    ),
    conflictedThrough: Math.max(
      held.conflictedThrough,
      incoming.conflictedThrough,
    ),
  };
  return { row, accepted: unblocked(row) };
}
