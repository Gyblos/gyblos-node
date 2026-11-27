// Durable delegated-key authority for local buyer APIs. It never constructs payments or keeps content.
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  buyerKeyCeiling,
  permitsBuyerKeyReservation,
} from '@gyblos/core/buyer-key-budget';
import { buyerAtomic } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  BUYER_KEY_CHARGE,
  BUYER_KEY_CODES,
  buyerKeyFail,
  parseBuyerApiKeySummary,
  parseBuyerKeyScope,
  type BuyerApiKeysSnapshot,
  type BuyerKeyCharge,
  type BuyerKeyScope,
} from '@gyblos/protocol/buyer-api-keys';
import {
  createDiagnostics,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';

import {
  bindKeyExecution,
  buyerKeyReviewQueue,
  buyerKeyState,
  keyReservation,
  type BuyerKeyReservation,
  type BuyerKeyState,
} from './buyer-api-key-state';
import { bounded } from './buyer-operation';
import {
  BUYER_KEY_LEDGER_DIAGNOSTICS,
  BUYER_PAYMENT_REVIEW,
} from './constants';

export interface BuyerApiKeyFiles {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
  close?(): Promise<void>;
}
export type BuyerApiKeyQuote = Omit<BuyerKeyReservation, 'id' | 'keyId'>;
const digest = (value: string) => createHash('sha256').update(value).digest();
export type ConfirmKeyCharge = (
  reservation: BuyerApiKeyQuote,
  scope: BuyerKeyScope,
  signal: AbortSignal,
) => Promise<string | undefined>;
export class BuyerApiKeys {
  private proof?: Promise<void>;
  private readonly checked = new Set<string>();
  private failed = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, AbortController>();
  private readonly diagnostics;
  constructor(
    private state: BuyerKeyState,
    private readonly files: BuyerApiKeyFiles,
    private readonly confirmCharge?: ConfirmKeyCharge,
    sink?: DiagnosticSink,
  ) {
    const catalog = BUYER_KEY_LEDGER_DIAGNOSTICS;
    this.diagnostics = createDiagnostics({
      component: catalog.component,
      operation: catalog.operation,
      phases: [catalog.phase],
      codes: [catalog.code],
      sink,
    });
  }
  private serial<T>(work: () => Promise<T>) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  private writable() {
    if (this.failed || this.closed) buyerKeyFail(BUYER_KEY_CODES.REVIEW);
  }
  assertReady() {
    this.writable();
    if (this.state.pending.some((item) => !this.active.has(item.id)))
      buyerKeyFail(BUYER_KEY_CODES.REVIEW);
  }
  private async save(next: BuyerKeyState) {
    this.writable();
    try {
      await this.files.write(JSON.stringify(next));
      this.state = next;
    } catch {
      this.failed = true;
      const { phase, code } = BUYER_KEY_LEDGER_DIAGNOSTICS;
      this.diagnostics.start().report({ phase, code });
      return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
    }
  }
  private key(id: string) {
    const key = this.state.keys.find((entry) => entry.id === id);
    if (!key) return buyerKeyFail(BUYER_KEY_CODES.UNAUTHORIZED);
    return key;
  }
  authenticate(secret: string | undefined) {
    if (this.closed || !secret || !BUYER_API_KEYS.TOKEN_PATTERN.test(secret))
      return undefined;
    const supplied = digest(secret);
    return this.state.keys.find(
      (key) =>
        !key.revoked &&
        timingSafeEqual(supplied, Buffer.from(key.digest, 'hex')),
    )?.id;
  }
  snapshot(): Promise<BuyerApiKeysSnapshot> {
    return this.serial(async () => ({
      version: BUYER_API_KEYS.VERSION,
      scope: structuredClone(this.state.scope),
      keys: this.state.keys.map(({ digest: _digest, ...key }) =>
        structuredClone(key),
      ),
      blocked:
        this.closed ||
        this.failed ||
        this.state.pending.some((item) => !this.active.has(item.id)),
    }));
  }
  create(name: string, limitAtomic: string) {
    return this.serial(async () => {
      this.assertReady();
      if (
        !buyerAtomic(limitAtomic) ||
        !name.trim() ||
        name.length > BUYER_API_KEYS.MAX_NAME
      )
        return buyerKeyFail();
      if (this.state.keys.length >= BUYER_API_KEYS.MAX_KEYS)
        return buyerKeyFail(BUYER_KEY_CODES.CAPACITY);
      const secret =
        BUYER_API_KEYS.TOKEN_PREFIX +
        randomBytes(BUYER_API_KEYS.TOKEN_BYTES).toString('base64url');
      const id = randomUUID();
      const summary = parseBuyerApiKeySummary({
        id,
        name: name.trim(),
        limitAtomic,
        spentAtomic: '0',
        settledAtomic: '0',
        approvedAtomic: '0',
        reservedAtomic: '0',
        revoked: false,
      });
      await this.save({
        ...this.state,
        keys: [
          ...this.state.keys,
          { ...summary, digest: digest(secret).toString('hex') },
        ],
      });
      return { id, secret };
    });
  }
  revoke(id: string) {
    return this.serial(async () => {
      this.writable();
      this.key(id);
      await this.save({
        ...this.state,
        keys: this.state.keys.map((key) =>
          key.id === id ? { ...key, revoked: true } : key,
        ),
      });
      for (const pending of this.state.pending)
        if (pending.keyId === id) this.active.get(pending.id)?.abort();
    });
  }
  private reserve(
    id: string,
    keyId: string,
    quote: BuyerApiKeyQuote,
    controller: AbortController,
  ) {
    return this.serial(async () => {
      this.assertReady();
      const key = this.key(keyId);
      if (key.revoked || controller.signal.aborted)
        return buyerKeyFail(BUYER_KEY_CODES.REVOKED);
      if (this.state.pending.some((item) => item.id === id))
        return buyerKeyFail();
      if (this.state.pending.length >= BUYER_API_KEYS.MAX_KEYS)
        return buyerKeyFail(BUYER_KEY_CODES.CAPACITY);
      const pending = keyReservation(quote, id, keyId);
      if (
        !permitsBuyerKeyReservation(
          key.limitAtomic,
          key.spentAtomic,
          key.reservedAtomic,
          pending.maxAtomic,
        )
      )
        return buyerKeyFail(BUYER_KEY_CODES.LIMIT);
      this.active.set(id, controller);
      await this.save({
        ...this.state,
        keys: this.state.keys.map((item) =>
          item.id === keyId
            ? {
                ...item,
                reservedAtomic: String(
                  BigInt(item.reservedAtomic) + BigInt(pending.maxAtomic),
                ),
              }
            : item,
        ),
        pending: [...this.state.pending, pending],
      });
    });
  }
  private complete(id: string, charge: string, kind: BuyerKeyCharge) {
    return this.serial(() => this.finish(id, charge, kind));
  }
  private async finish(id: string, charge: string, kind: BuyerKeyCharge) {
    this.writable();
    const pending = this.state.pending.find((entry) => entry.id === id);
    if (
      !pending ||
      !buyerAtomic(charge) ||
      BigInt(charge) > BigInt(pending.maxAtomic) ||
      !Object.values(BUYER_KEY_CHARGE).includes(kind)
    )
      return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
    await this.save({
      ...this.state,
      keys: this.state.keys.map((key) =>
        key.id === pending.keyId
          ? parseCompletedKey(key, pending.maxAtomic, charge, kind)
          : key,
      ),
      pending: this.state.pending.filter((entry) => entry.id !== id),
    });
    this.active.delete(id);
    this.checked.delete(id);
  }
  reconcileAbandoned(manual = false) {
    if (!this.proof)
      this.proof = this.recoverCharge(manual).finally(() => {
        this.proof = undefined;
      });
    return this.proof;
  }
  private async recoverCharge(manual: boolean) {
    const prove = this.confirmCharge;
    if (!prove || this.closed) return;
    const queue = buyerKeyReviewQueue(
      this.state.pending,
      this.active,
      this.checked,
      manual,
    );
    const deadline = AbortSignal.timeout(BUYER_PAYMENT_REVIEW.deadlineMs);
    const review = async () => {
      while (!deadline.aborted && !this.closed) {
        const item = queue.shift();
        if (!item) return;
        this.checked.add(item.id);
        const charge = await bounded(
          prove(item, this.state.scope, deadline),
          deadline,
        ).catch(() => undefined);
        if (charge === undefined) continue;
        await this.serial(async () => {
          if (
            !this.closed &&
            !this.active.has(item.id) &&
            this.state.pending.includes(item)
          )
            await this.finish(item.id, charge, BUYER_KEY_CHARGE.SETTLED);
        });
      }
    };
    const workers = Math.min(queue.length, BUYER_PAYMENT_REVIEW.concurrency);
    await Promise.all(Array.from({ length: workers }, review));
  }

  operation(keyId: string) {
    this.assertReady();
    if (this.key(keyId).revoked) return buyerKeyFail(BUYER_KEY_CODES.REVOKED);
    const id = randomUUID();
    const controller = new AbortController();
    let finished = false;
    let reserved = false;
    let maximum: string | undefined;
    return {
      signal: controller.signal,
      reserved: () => reserved,
      completed: () => finished,
      maximum: () => maximum,
      ceiling: (configured: string) => {
        this.assertReady();
        const key = this.key(keyId);
        if (key.revoked || controller.signal.aborted)
          return buyerKeyFail(BUYER_KEY_CODES.REVOKED);
        const amount = buyerKeyCeiling(
          key.limitAtomic,
          key.spentAtomic,
          key.reservedAtomic,
          configured,
        );
        return amount ?? buyerKeyFail(BUYER_KEY_CODES.REVIEW);
      },
      reserve: async (quote: BuyerApiKeyQuote) => {
        if (finished || reserved) return buyerKeyFail();
        await this.reserve(id, keyId, quote, controller);
        reserved = true;
        maximum = quote.maxAtomic;
      },
      bindExecution: (requestId: string, executionDigest: string) =>
        this.serial(async () => {
          this.writable();
          const pending = bindKeyExecution(
            this.state.pending,
            id,
            keyId,
            requestId,
            executionDigest,
            controller.signal,
          );
          await this.save({ ...this.state, pending });
        }),
      complete: async (charge: string, kind: BuyerKeyCharge) => {
        if (finished || !reserved) return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
        await this.complete(id, charge, kind);
        finished = true;
        reserved = false;
      },
      // Only composition with authoritative proof of no financial obligation may release this.
      releaseUnsent: async () => {
        if (finished || !reserved) return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
        await this.complete(id, '0', BUYER_KEY_CHARGE.SETTLED);
        reserved = false;
        maximum = undefined;
      },
      abandon: () => {
        this.active.delete(id);
        if (reserved && !finished && !this.closed)
          void this.reconcileAbandoned().catch(() => {});
      },
    };
  }
  async close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    await this.queue;
    await this.files.close?.();
  }
}
function parseCompletedKey(
  key: BuyerKeyState['keys'][number],
  reserved: string,
  charge: string,
  kind: BuyerKeyCharge,
) {
  const { digest: secretDigest, ...summary } = key;
  return {
    ...parseBuyerApiKeySummary({
      ...summary,
      reservedAtomic: String(BigInt(key.reservedAtomic) - BigInt(reserved)),
      spentAtomic: String(BigInt(key.spentAtomic) + BigInt(charge)),
      settledAtomic: String(
        BigInt(key.settledAtomic) +
          (kind === BUYER_KEY_CHARGE.SETTLED ? BigInt(charge) : 0n),
      ),
      approvedAtomic: String(
        BigInt(key.approvedAtomic) +
          (kind === BUYER_KEY_CHARGE.APPROVED ? BigInt(charge) : 0n),
      ),
    }),
    digest: secretDigest,
  };
}
export type BuyerApiKeyOperation = ReturnType<BuyerApiKeys['operation']>;
export async function createBuyerApiKeys(options: {
  files: BuyerApiKeyFiles;
  scope: BuyerKeyScope;
  confirmCharge?: ConfirmKeyCharge;
  diagnostics?: DiagnosticSink;
}) {
  const scope = parseBuyerKeyScope(options.scope);
  return new BuyerApiKeys(
    buyerKeyState(await options.files.read(), scope),
    options.files,
    options.confirmCharge,
    options.diagnostics,
  );
}
