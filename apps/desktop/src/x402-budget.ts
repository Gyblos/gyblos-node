// Durable reservation before transmission; uncertain requests remain blocked across restarts.
// This permission bounds only chat requests made by this desktop, never other clients of the buyer.
import { randomUUID } from 'node:crypto';

import {
  isOpeningIntent,
  type desktopOpening,
  type DesktopRequestBinding,
} from '@gyblos/node/desktop-opening';
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
  openingIntent?: string;
}
export class X402Budget {
  private state: State | null = null;
  private failed = false;
  private liveIntent?: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly files: Files,
    readonly opening?: ReturnType<typeof desktopOpening>,
  ) {}
  private async recover(state: State) {
    if (
      state.pending &&
      state.openingIntent &&
      (await this.opening?.retire(state.openingIntent))
    ) {
      await this.save({
        ...state,
        openingIntent: undefined,
        pending: null,
        summary: { ...state.summary, blocked: false },
      });
    }
    return this.state!;
  }
  async review(
    observe: (
      ref: DesktopRequestBinding,
      policy: BuyerApiPolicy,
    ) => Promise<{ chargeAtomic: string; transaction: string } | undefined>,
  ) {
    const state = await this.serial(async () =>
      this.recoverIfIdle(await this.load()),
    );
    if (!state.pending) return true;
    if (
      !state.openingIntent ||
      this.liveIntent === state.openingIntent ||
      !state.summary.policy
    )
      return false;
    const ref = await this.opening?.reference(state.openingIntent);
    if (!ref) return false;
    const result = await observe(ref, state.summary.policy);
    if (!result) return false;
    await this.complete(state.pending, { ...result, free: false });
    return true;
  }
  private recoverIfIdle(state: State) {
    return state.openingIntent && state.openingIntent !== this.liveIntent
      ? this.recover(state)
      : state;
  }
  recoverOpening() {
    return this.serial(async () => {
      this.liveIntent = undefined;
      await this.recover(await this.load());
    });
  }
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
    if (
      saved.openingIntent !== undefined &&
      !isOpeningIntent(saved.openingIntent)
    )
      throw new Error('Invalid payment reservation');
    this.state = {
      ...(saved.openingIntent && { openingIntent: saved.openingIntent }),
      version: DESKTOP_X402.VERSION,
      summary,
      pending: saved.pending,
    };
    return this.state;
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
      const state = await this.load();
      const current = (
        state.openingIntent && state.openingIntent !== this.liveIntent
          ? await this.recover(state)
          : state
      ).summary;
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
  reserve(id: string, confirmedPolicy?: BuyerApiPolicy, intent?: string) {
    return this.serial(async () => {
      const state = await this.load();
      // A confirmed seller authorizes this response only. Persist its reservation
      // with the same recovery rules as a request under an optional chat budget.
      const single = !state.summary.active && confirmedPolicy;
      const summary = single
        ? {
            ...state.summary,
            sessionId: randomUUID(),
            policy: single,
            limitAtomic: single.maxAtomic,
            spentAtomic: '0',
          }
        : state.summary;
      if (
        this.failed ||
        state.pending ||
        (!single && !summary.active) ||
        (confirmedPolicy &&
          confirmedPolicy.policyId !== summary.policy?.policyId) ||
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
      if (intent) {
        await this.opening!.arm(intent);
        this.liveIntent = intent;
      }
      await this.save({
        ...state,
        openingIntent: intent,
        pending: id,
        summary: { ...summary, blocked: true },
      });
      return structuredClone(summary.policy);
    });
  }
  // A free-only turn cannot create a financial obligation. Record its completed answer independently of any paid budget.
  recordFree(id: string, policy: BuyerApiPolicy) {
    return this.serial(async () => {
      const state = await this.load();
      if (state.pending || this.failed || policy.maxAtomic !== '0')
        throw new Error('Chat history is unavailable or needs review.');
      const record = {
        id,
        policy,
        sessionId: randomUUID(),
        at: Date.now(),
        chargeAtomic: '0',
        transaction: null,
        free: true,
      };
      const summary = parseX402Summary({
        ...state.summary,
        records: [...state.summary.records, record],
      });
      await this.save({ ...state, summary });
      return structuredClone(summary);
    });
  }
  complete(
    id: string,
    result: { chargeAtomic: string; transaction: string | null; free: boolean },
    selectedModel?: string,
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
            ...(selectedModel && { selectedModel }),
            ...result,
          },
        ],
      });
      await this.save({
        ...state,
        summary: next,
        openingIntent: undefined,
        pending: null,
      });
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
        openingIntent: undefined,
        pending: null,
        summary: { ...state.summary, blocked: false },
      });
    });
  }
  // Zero spending authority cannot leave a financial obligation; this records no successful response.
  releaseFree(id: string) {
    return this.serial(async () => {
      const state = await this.load();
      if (
        this.failed ||
        state.pending !== id ||
        state.summary.policy?.maxAtomic !== '0'
      )
        throw new Error('Payment needs review');
      await this.save({
        ...state,
        openingIntent: undefined,
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
