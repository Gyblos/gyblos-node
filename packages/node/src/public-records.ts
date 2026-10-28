// Owns catalog/presence/withdrawal snapshots over one durable public-v2 allocator.
// Advertised lifetimes never extend observed readiness; no engine, payment or journal calls.
import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
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

import { SELLER_PUBLIC_RECORDS } from './constants';
import type { SellerSequence } from './public-sequence';

export interface SellerPublicRecords {
  current(): SignedPublicV2;
  refresh(force?: boolean): Promise<SignedPublicV2>;
  presence(signal?: AbortSignal): Promise<SignedPublicV2>;
  withdraw(): Promise<SignedPublicV2 | undefined>;
}
export interface SellerRecordOptions {
  // Read on every signing: the catalog to sign now, or undefined when no model may be listed.
  template: () => PublicCatalogV2 | undefined;
  sequence: SellerSequence;
  signer: Signer;
  now: () => number;
  validUntil: () => number;
  readiness?: () => QuoteReadiness;
  catalogMs?: number;
  renewBeforeMs?: number;
}
class SellerRecords implements SellerPublicRecords {
  private catalog: SignedPublicV2 | undefined;
  private active = false;
  private failed = false;
  private epoch = 0;
  private previous = Promise.resolve();
  private pendingPresences = 0;
  private observationGeneration: number | undefined;
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
        if (
          error instanceof ControlError &&
          (error.code === CONTROL_CODES.CANCELLED ||
            error.code === CONTROL_CODES.BUSY)
        )
          throw error;
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
    this.assertObservation(this.observationGeneration);
    if (this.catalog.record.expiresAt > this.options.validUntil())
      return controlFail(CONTROL_CODES.STALE);
    return this.catalog;
  }
  private assertObservation(generation?: number) {
    const state = this.options.readiness?.();
    const now = this.options.now();
    if (state?.busy) return controlFail(CONTROL_CODES.BUSY);
    if (this.options.validUntil() <= now || (state && state.observedAt > now))
      return controlFail(CONTROL_CODES.EXPIRED);
    if (state && generation !== undefined && state.generation !== generation)
      return controlFail(CONTROL_CODES.STALE);
    return state?.generation;
  }
  refresh(force = false) {
    const generation = this.epoch;
    return this.enqueue(async () => {
      if (generation !== this.epoch)
        return controlFail(CONTROL_CODES.CANCELLED);
      const now = controlInteger(this.options.now());
      const deadline = controlInteger(this.options.validUntil());
      const observation = this.assertObservation();
      if (
        deadline <= now ||
        (this.catalog && this.catalog.record.issuedAt > now)
      )
        return controlFail(CONTROL_CODES.EXPIRED);
      if (
        !force &&
        this.active &&
        observation === this.observationGeneration &&
        this.catalog &&
        this.catalog.record.expiresAt - now > this.renewBefore
      )
        return this.catalog;
      // A catalog never lists zero models; with none listable there is nothing current to sign.
      const template = this.options.template();
      if (!template?.models.length) return controlFail(CONTROL_CODES.EXPIRED);
      const sequence = await this.options.sequence.next(
        this.catalog?.record.sequence ?? 0,
      );
      const signed = await signPublicV2(
        {
          ...template,
          sequence,
          issuedAt: now,
          expiresAt: Math.min(deadline, now + this.lifetime),
        },
        this.options.signer,
      );
      if (generation !== this.epoch)
        return controlFail(CONTROL_CODES.CANCELLED);
      validatePublicV2Time(signed.record, this.options.now());
      this.assertObservation(observation);
      if (signed.record.expiresAt > this.options.validUntil())
        return controlFail(CONTROL_CODES.STALE);
      this.catalog = signed;
      this.observationGeneration = observation;
      this.active = true;
      return signed;
    });
  }
  async presence(signal?: AbortSignal) {
    cancelled(signal);
    if (this.pendingPresences >= CONTROL_CAPACITY.queries)
      return controlFail(CONTROL_CODES.BUSY);
    this.pendingPresences++;
    const generation = this.epoch;
    try {
      return await this.enqueue(async () => {
        cancelled(signal);
        const held = this.current();
        const now = this.options.now();
        const sequence = await this.options.sequence.next(held.record.sequence);
        cancelled(signal);
        const digest = await catalogDigestV2(held.record);
        cancelled(signal);
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
            catalogDigest: digest,
            state: PUBLIC_PRESENCE_STATE,
          },
          async (bytes) => {
            cancelled(signal);
            return this.options.signer(bytes);
          },
        );
        cancelled(signal);
        if (generation !== this.epoch)
          return controlFail(CONTROL_CODES.CANCELLED);
        this.current();
        validatePublicV2Time(signed.record, this.options.now());
        return signed;
      });
    } finally {
      this.pendingPresences--;
    }
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

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) return controlFail(CONTROL_CODES.CANCELLED);
}
