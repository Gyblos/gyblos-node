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
class SellerRecords implements SellerPublicRecords {
  private catalog: SignedPublicV2 | undefined;
  private active = false;
  private failed = false;
  private epoch = 0;
  private previous = Promise.resolve();
  private readonly lifetime: number;
  private readonly renewBefore: number;
  constructor(private readonly options: SellerRecordOptions) {
    this.lifetime = controlInteger(
      options.catalogMs ?? SELLER_PUBLIC_RECORDS.catalogMs,
      1,
      PUBLIC_RECORD_LIMITS.catalogLifetimeMs,
    );
    this.renewBefore = controlInteger(
      options.renewBeforeMs ??
        Math.min(SELLER_PUBLIC_RECORDS.renewBeforeMs, this.lifetime - 1),
      0,
      this.lifetime - 1,
    );
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.previous.then(async () => {
      if (this.failed) return controlFail(CONTROL_CODES.INTERNAL);
      try {
        return await operation();
      } catch (error) {
        this.active = false;
        if (!(error instanceof ControlError)) this.failed = true;
        throw error;
      }
    });
    this.previous = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  current(): SignedPublicV2 {
    if (this.failed || !this.active || !this.catalog)
      return controlFail(CONTROL_CODES.STALE);
    validatePublicV2Time(this.catalog.record, this.options.now());
    return this.catalog;
  }
  refresh(force = false) {
    const generation = this.epoch;
    return this.enqueue(async () => {
      if (generation !== this.epoch)
        return controlFail(CONTROL_CODES.CANCELLED);
      const now = controlInteger(this.options.now());
      const deadline = controlInteger(this.options.validUntil());
      if (
        deadline <= now ||
        (this.catalog && this.catalog.record.issuedAt > now)
      )
        return controlFail(CONTROL_CODES.EXPIRED);
      if (
        !force &&
        this.active &&
        this.catalog &&
        this.catalog.record.expiresAt - now > this.renewBefore
      )
        return this.catalog;
      const sequence = await this.options.sequence.next(
        this.catalog?.record.sequence ?? 0,
      );
      const signed = await signPublicV2(
        {
          ...this.options.template,
          sequence,
          issuedAt: now,
          expiresAt: Math.min(deadline, now + this.lifetime),
        },
        this.options.signer,
      );
      if (generation !== this.epoch)
        return controlFail(CONTROL_CODES.CANCELLED);
      validatePublicV2Time(signed.record, this.options.now());
      this.catalog = signed;
      this.active = true;
      return signed;
    });
  }
  presence() {
    const generation = this.epoch;
    return this.enqueue(async () => {
      const held = this.current();
      const now = this.options.now();
      const sequence = await this.options.sequence.next(held.record.sequence);
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
        this.options.signer,
      );
      if (generation !== this.epoch)
        return controlFail(CONTROL_CODES.CANCELLED);
      this.current();
      validatePublicV2Time(signed.record, this.options.now());
      return signed;
    });
  }
  withdraw() {
    const wasActive = this.active;
    this.active = false;
    this.epoch++;
    return this.enqueue(async () => {
      const held = this.catalog;
      const now = this.options.now();
      if (
        !wasActive ||
        !held ||
        now >= held.record.expiresAt ||
        now < held.record.issuedAt
      )
        return undefined;
      const sequence = await this.options.sequence.next(held.record.sequence);
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
        this.options.signer,
      );
    });
  }
}
export async function createSellerRecords(
  options: SellerRecordOptions,
): Promise<SellerPublicRecords> {
  const records = new SellerRecords(options);
  await records.refresh();
  return records;
}
