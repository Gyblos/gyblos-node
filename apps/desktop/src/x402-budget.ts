// Durable reservation before transmission; uncertain requests remain blocked across restarts.
// This permission bounds only chat requests made by this desktop, never other clients of the buyer.
import { randomUUID } from 'node:crypto';

import { buyerAtomic, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

import {
  DESKTOP_X402,
  emptyX402,
  parseX402Summary,
  x402Id,
  x402Policy,
  type X402Summary,
} from './x402-model';

interface Files {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}
interface State {
  version: typeof DESKTOP_X402.VERSION;
  summary: X402Summary;
  pending: string | null;
}
export class X402Budget {
  private state: State | null = null;
  private failed = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly files: Files) {}
  private serial<T>(work: () => Promise<T>) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  private async load() {
    if (this.state) return this.state;
    const text = await this.files.read();
    if (text === undefined)
      return (this.state = {
        version: DESKTOP_X402.VERSION,
        summary: emptyX402(),
        pending: null,
      });
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object')
      throw new Error('Spending record unavailable');
    const saved = value as Record<string, unknown>;
    if (
      saved.version !== DESKTOP_X402.VERSION ||
      (saved.pending !== null && !x402Id(saved.pending))
    )
      throw new Error('Spending record unavailable');
    const summary = parseX402Summary(saved.summary);
    if (Boolean(saved.pending) !== summary.blocked)
      throw new Error('Spending record unavailable');
    return (this.state = {
      version: DESKTOP_X402.VERSION,
      summary,
      pending: saved.pending,
    });
  }
  private async save(next: State) {
    try {
      await this.files.write(JSON.stringify(next));
      this.state = next;
    } catch {
      this.failed = true;
      throw new Error(
        'Spending record could not be saved. No further requests are allowed.',
      );
    }
  }
  async summary() {
    return this.serial(async () => {
      const current = (await this.load()).summary;
      return structuredClone({
        ...current,
        blocked: current.blocked || this.failed,
      });
    });
  }
  authorize(input: BuyerApiPolicy, limitAtomic: string) {
    return this.serial(async () => {
      const state = await this.load();
      if (this.failed || state.pending || state.summary.active)
        throw new Error('Finish or review the existing chat budget first');
      const policy = x402Policy(input);
      if (
        !buyerAtomic(limitAtomic) ||
        BigInt(limitAtomic) < BigInt(policy.maxAtomic)
      )
        throw new Error('Budget must cover the maximum cost of one response');
      await this.save({
        version: DESKTOP_X402.VERSION,
        pending: null,
        summary: {
          ...state.summary,
          active: true,
          blocked: false,
          sessionId: randomUUID(),
          policy,
          limitAtomic,
          spentAtomic: '0',
        },
      });
      return structuredClone(this.state!.summary);
    });
  }
  reserve(id: string) {
    return this.serial(async () => {
      const state = await this.load();
      const summary = state.summary;
      if (
        this.failed ||
        state.pending ||
        !summary.active ||
        !summary.policy ||
        !x402Id(id) ||
        summary.records.some((record) => record.id === id) ||
        summary.records.length >= DESKTOP_X402.MAX_RECORDS
      )
        throw new Error('Chat budget is unavailable or needs review');
      if (
        BigInt(summary.spentAtomic) + BigInt(summary.policy.maxAtomic) >
        BigInt(summary.limitAtomic)
      )
        throw new Error(
          'Remaining budget cannot cover the maximum cost of another response',
        );
      await this.save({
        ...state,
        pending: id,
        summary: { ...summary, blocked: true },
      });
      return structuredClone(summary.policy);
    });
  }
  complete(
    id: string,
    result: { chargeAtomic: string; transaction: string | null; free: boolean },
  ) {
    return this.serial(async () => {
      const state = await this.load();
      const current = state.summary;
      if (
        this.failed ||
        state.pending !== id ||
        !current.policy ||
        !current.sessionId ||
        !buyerAtomic(result.chargeAtomic) ||
        BigInt(result.chargeAtomic) > BigInt(current.policy.maxAtomic)
      )
        throw new Error('Payment needs review');
      const next = parseX402Summary({
        ...current,
        blocked: false,
        spentAtomic: String(
          BigInt(current.spentAtomic) + BigInt(result.chargeAtomic),
        ),
        records: [
          ...current.records,
          {
            id,
            sessionId: current.sessionId,
            at: Date.now(),
            policy: current.policy,
            ...result,
          },
        ],
      });
      await this.save({ ...state, summary: next, pending: null });
      return structuredClone(next);
    });
  }
  // Only a trusted buyer response can prove non-transmission; never exposed as a renderer action.
  cancelUnsent(id: string) {
    return this.serial(async () => {
      const state = await this.load();
      if (this.failed || state.pending !== id)
        throw new Error('Payment needs review');
      await this.save({
        ...state,
        pending: null,
        summary: { ...state.summary, blocked: false },
      });
    });
  }
  finish() {
    return this.serial(async () => {
      const state = await this.load();
      if (this.failed || state.pending)
        throw new Error(
          'An unfinished payment needs review before this budget can close',
        );
      await this.save({
        ...state,
        summary: { ...state.summary, active: false },
      });
      return structuredClone(this.state!.summary);
    });
  }
}
