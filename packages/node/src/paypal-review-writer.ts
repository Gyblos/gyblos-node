// Serializes the private decision, capture intent and outcome of a sandbox review.
// A failed step seals the journal; it never retries a payment.
import {
  paypalSandboxPaths,
  paypalSandboxReviewPaths,
} from '@gyblos/config/home';
import { canonicalJson } from '@gyblos/protocol';
import {
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFileOnce,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import {
  parsePaypalWaiverArchive,
  parsePaypalWaiverOutcome,
  PAYPAL_REVIEW_MAX_BYTES,
  paypalArchiveDigest,
  paypalPostReviewState,
  paypalReviewFailure,
} from './paypal-review-archive';
import {
  parsePaypalSessionState,
  type PaypalSessionRecord,
} from './paypal-session-record';
import type {
  PaypalReviewJournal,
  PaypalWaiverArchive,
  PaypalWaiverOutcome,
} from './paypal-session-review';

type Options = {
  root: string;
  lock: ProcessLock;
  stateMaxBytes: number;
  write(value: PaypalSessionRecord): Promise<void>;
  seal(value: boolean): void;
};
class PaypalReviewWriter implements PaypalReviewJournal {
  private archive: PaypalWaiverArchive | undefined;
  private outcome: PaypalWaiverOutcome | undefined;
  private capturing = false;
  private active = true;
  private pending: Promise<void> | undefined;
  constructor(private readonly options: Options) {}
  private async step<T>(action: () => Promise<T>): Promise<T> {
    if (!this.active || this.pending) return paypalReviewFailure();
    const run = action();
    const pending = run.then(
      () => {},
      () => {},
    );
    this.pending = pending;
    void pending.then(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return run;
  }
  async close(): Promise<void> {
    this.active = false;
    await this.pending;
  }
  private async currentRecord() {
    await this.options.lock.verify();
    const paths = paypalSandboxPaths(this.options.root);
    const content = await readPrivateFile(
      paths.state,
      this.options.stateMaxBytes,
    );
    if (content === undefined) return paypalReviewFailure();
    const current = parsePaypalSessionState(JSON.parse(content));
    if (current.legacyBlocked || !current.record) return paypalReviewFailure();
    return current.record;
  }
  private async saveArchive(value: PaypalWaiverArchive) {
    if (this.archive) return paypalReviewFailure();
    const current = await this.currentRecord();
    const requested = parsePaypalWaiverArchive(value);
    if (canonicalJson(current) !== canonicalJson(requested.session))
      return paypalReviewFailure();
    const paths = paypalSandboxPaths(this.options.root);
    await ensurePrivateDirectory(paths.reviewDirectory);
    const reviewPaths = paypalSandboxReviewPaths(
      this.options.root,
      current.requestId,
    );
    this.options.seal(true);
    await this.options.lock.verify();
    const text = JSON.stringify(requested);
    await writePrivateFileOnce(
      reviewPaths.decision,
      text,
      PAYPAL_REVIEW_MAX_BYTES,
    );
    if (
      (await readPrivateFile(reviewPaths.decision, PAYPAL_REVIEW_MAX_BYTES)) !==
      text
    )
      return paypalReviewFailure();
    this.archive = requested;
    return paypalArchiveDigest(requested);
  }
  private async saveOutcome(value: PaypalWaiverOutcome) {
    const archive = this.archive;
    if (!archive || !this.capturing || this.outcome)
      return paypalReviewFailure();
    const requested = parsePaypalWaiverOutcome(value, archive);
    const reviewPaths = paypalSandboxReviewPaths(
      this.options.root,
      archive.session.requestId,
    );
    const decision = await readPrivateFile(
      reviewPaths.decision,
      PAYPAL_REVIEW_MAX_BYTES,
    );
    if (
      decision === undefined ||
      canonicalJson(parsePaypalWaiverArchive(JSON.parse(decision))) !==
        canonicalJson(archive)
    )
      return paypalReviewFailure();
    await this.options.lock.verify();
    const text = JSON.stringify(requested);
    await writePrivateFileOnce(
      reviewPaths.outcome,
      text,
      PAYPAL_REVIEW_MAX_BYTES,
    );
    if (
      (await readPrivateFile(reviewPaths.outcome, PAYPAL_REVIEW_MAX_BYTES)) !==
      text
    )
      return paypalReviewFailure();
    this.outcome = requested;
  }
  private async saveState(value: PaypalSessionRecord) {
    const archive = this.archive;
    if (!archive) return paypalReviewFailure();
    const expectedCurrent = this.capturing
      ? paypalPostReviewState(archive)
      : archive.session;
    if (
      canonicalJson(await this.currentRecord()) !==
      canonicalJson(expectedCurrent)
    )
      return paypalReviewFailure();
    if (!this.capturing) {
      if (
        canonicalJson(value) !== canonicalJson(paypalPostReviewState(archive))
      )
        return paypalReviewFailure();
      await this.options.write(value);
      this.capturing = true;
      return;
    }
    if (
      !this.outcome ||
      canonicalJson(value) !==
        canonicalJson(paypalPostReviewState(archive, this.outcome.captureId))
    )
      return paypalReviewFailure();
    await this.options.write(value);
    this.options.seal(false);
  }
  archiveWaiver = (value: PaypalWaiverArchive) =>
    this.step(() => this.saveArchive(value));
  archiveOutcome = (value: PaypalWaiverOutcome) =>
    this.step(() => this.saveOutcome(value));
  write = (value: PaypalSessionRecord) =>
    this.step(() => this.saveState(value));
}
export function createPaypalReviewWriter(options: Options): PaypalReviewWriter {
  return new PaypalReviewWriter(options);
}
