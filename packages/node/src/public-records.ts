// Owns catalog/presence/withdrawal snapshots over one durable public-v2 allocator.
// Advertised lifetimes never extend observed readiness; no engine, payment or journal calls.
import {
  CONTROL_CODES,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import type {
  PublicCatalogV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import {
  ControlError,
  controlFail,
  controlInteger,
} from '@gyblos/protocol/control-validation';
import {
  catalogDigestV2,
  signPublicV2,
  validatePublicV2Time,
} from '@gyblos/protocol/public-v2';
import type { Signer } from '@gyblos/protocol/signing';

import { SELLER_PUBLIC_RECORDS } from './constants.js';
import type { SellerSequence } from './public-sequence.js';

export interface SellerPublicRecords {
  current(): SignedPublicV2;
  refresh(force?: boolean): Promise<SignedPublicV2>;
  presence(): Promise<SignedPublicV2>;
  withdraw(): Promise<SignedPublicV2 | undefined>;
}
export interface SellerRecordOptions {
  template: PublicCatalogV2;
  sequence: SellerSequence;
  signer: Signer;
  now: () => number;
  validUntil: () => number;
  catalogMs?: number;
  renewBeforeMs?: number;
}
export async function createSellerRecords(
  options: SellerRecordOptions,
): Promise<SellerPublicRecords> {
  const lifetime = controlInteger(
    options.catalogMs ?? SELLER_PUBLIC_RECORDS.catalogMs,
    1,
    PUBLIC_RECORD_LIMITS.catalogLifetimeMs,
  );
  const renewBefore = controlInteger(
    options.renewBeforeMs ??
      Math.min(SELLER_PUBLIC_RECORDS.renewBeforeMs, lifetime - 1),
    0,
    lifetime - 1,
  );
  let catalog: SignedPublicV2 | undefined;
  let active = false;
  let failed = false;
  let epoch = 0;
  let previous = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = previous.then(async () => {
      if (failed) return controlFail(CONTROL_CODES.INTERNAL);
      try {
        return await operation();
      } catch (error) {
        active = false;
        if (!(error instanceof ControlError)) failed = true;
        throw error;
      }
    });
    previous = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function current(): SignedPublicV2 {
    if (failed || !active || !catalog) return controlFail(CONTROL_CODES.STALE);
    validatePublicV2Time(catalog.record, options.now());
    return catalog;
  }
  function refresh(force = false) {
    const generation = epoch;
    return enqueue(async () => {
      if (generation !== epoch) return controlFail(CONTROL_CODES.CANCELLED);
      const now = controlInteger(options.now());
      const deadline = controlInteger(options.validUntil());
      if (deadline <= now || (catalog && catalog.record.issuedAt > now))
        return controlFail(CONTROL_CODES.EXPIRED);
      if (
        !force &&
        active &&
        catalog &&
        catalog.record.expiresAt - now > renewBefore
      )
        return catalog;
      const sequence = await options.sequence.next(
        catalog?.record.sequence ?? 0,
      );
      const signed = await signPublicV2(
        {
          ...options.template,
          sequence,
          issuedAt: now,
          expiresAt: Math.min(deadline, now + lifetime),
        },
        options.signer,
      );
      if (generation !== epoch) return controlFail(CONTROL_CODES.CANCELLED);
      validatePublicV2Time(signed.record, options.now());
      catalog = signed;
      active = true;
      return signed;
    });
  }
  async function presence() {
    const generation = epoch;
    return enqueue(async () => {
      const held = current();
      const now = options.now();
      const sequence = await options.sequence.next(held.record.sequence);
      const signed = await signPublicV2(
        {
          schemaVersion: held.record.schemaVersion,
          kind: PUBLIC_RECORD_KINDS.PRESENCE,
          owner: held.record.owner,
          nodeId: held.record.nodeId,
          sequence,
          issuedAt: now,
          expiresAt: Math.min(
            held.record.expiresAt,
            now + PUBLIC_RECORD_LIMITS.presenceLifetimeMs,
          ),
          catalogDigest: await catalogDigestV2(held.record),
          state: PUBLIC_PRESENCE_STATE,
        },
        options.signer,
      );
      if (generation !== epoch) return controlFail(CONTROL_CODES.CANCELLED);
      current();
      validatePublicV2Time(signed.record, options.now());
      return signed;
    });
  }
  function withdraw() {
    const wasActive = active;
    active = false;
    epoch++;
    return enqueue(async () => {
      const held = catalog;
      const now = options.now();
      if (
        !wasActive ||
        !held ||
        now >= held.record.expiresAt ||
        now < held.record.issuedAt
      )
        return undefined;
      const sequence = await options.sequence.next(held.record.sequence);
      return signPublicV2(
        {
          schemaVersion: held.record.schemaVersion,
          kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
          owner: held.record.owner,
          nodeId: held.record.nodeId,
          sequence,
          issuedAt: now,
          expiresAt: Math.min(
            held.record.expiresAt,
            now + PUBLIC_RECORD_LIMITS.withdrawalLifetimeMs,
          ),
          catalogDigest: await catalogDigestV2(held.record),
        },
        options.signer,
      );
    });
  }
  await refresh();
  return { current, refresh, presence, withdraw };
}
