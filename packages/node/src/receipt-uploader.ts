// Uploads this node's pending signed receipts to the metrics collector in signed envelopes. It never
// blocks or retries inference; a failure keeps receipts pending (the store never evicts them) and
// backs off. A clock the collector rejects is corrected from the collector's reply.
import { RECEIPT_UPLOADER } from '@gyblos/config';
import type { P2PRole } from '@gyblos/protocol/constants';
import {
  OBSERVATION_UPLOAD,
  signObservationUpload,
  type ObservationUploadV1,
} from '@gyblos/protocol/observation-upload';
import {
  RECEIPT_UPLOAD,
  signReceiptUpload,
  type ReceiptUploadClient,
  type ReceiptUploadV1,
} from '@gyblos/protocol/receipt-upload';
import type { Signer } from '@gyblos/protocol/signing';

import {
  RECEIPT_UPLOADER_HTTP,
  RECEIPT_UPLOADER_OUTCOMES,
  RECEIPT_UPLOADER_RETRYABLE,
  type ReceiptUploaderOutcome,
} from './constants';
import type { ObservationBuffer } from './observation-buffer';
import type { LocalReceiptStore } from './receipt-store';
import type { ReceiptUploadCursor } from './receipt-upload-types';

export interface ReceiptUploaderOptions {
  store: Pick<LocalReceiptStore, 'listPending' | 'markUploaded'>;
  nodeId: string;
  role: P2PRole;
  client: ReceiptUploadClient;
  signer: Signer;
  // Collector base URL, for example https://collector.gyblos.com/v1.
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
  // Content-free telemetry events to send alongside receipts; absent means receipts only.
  observations?: ObservationBuffer;
}
export interface UploadResult {
  outcome: ReceiptUploaderOutcome;
  uploaded: number;
}
export interface ReceiptUploader {
  uploadOnce(): Promise<UploadResult>;
  // Runs uploads in the background until close(); nothing starts on creation.
  start(): void;
  close(): Promise<void>;
}

function nonce() {
  const bytes = crypto.getRandomValues(
    new Uint8Array(RECEIPT_UPLOAD.nonceBytes),
  );
  return Array.from(bytes, (byte) =>
    byte.toString(RECEIPT_UPLOADER_HTTP.hexRadix).padStart(2, '0'),
  ).join('');
}
async function replyBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object'
    ? Reflect.get(value, name)
    : undefined;
}
function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}
// The collector refused the content itself (not capacity, clock, size or availability).
function invalidContent(status: number) {
  return (
    status >= RECEIPT_UPLOADER_HTTP.badRequest &&
    status < RECEIPT_UPLOADER_HTTP.serverError &&
    !RECEIPT_UPLOADER_RETRYABLE.has(status)
  );
}

interface UploadContext {
  options: ReceiptUploaderOptions;
  fetcher: typeof fetch;
  now: () => number;
  baseUrl: string;
  // Aborted by close(): stops the request, the store read and acknowledgements in flight.
  signal: AbortSignal;
  // Collector time minus this clock, learned from a STALE_UPLOAD reply.
  offsetMs: number;
  // Receipts the collector refused as invalid, skipped for this process so one cannot block the rest.
  refused: Set<string>;
}

const retry = (): UploadResult => ({
  outcome: RECEIPT_UPLOADER_OUTCOMES.RETRY,
  uploaded: 0,
});

// Builds the signed JSON body for one attempt at the given (possibly corrected) send time.
type SignedBody = (sentAt: number) => Promise<string>;

function post(context: UploadContext, path: string, body: string) {
  return context.fetcher(`${context.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    // A redirect is never the collector answering: refuse it rather than trust a 200 from elsewhere.
    redirect: 'error',
    signal: AbortSignal.any([
      context.signal,
      AbortSignal.timeout(RECEIPT_UPLOADER.requestMs),
    ]),
  });
}

function receiptsBody(
  context: UploadContext,
  cursors: ReceiptUploadCursor[],
): SignedBody {
  const { options } = context;
  return async (sentAt) => {
    const upload: ReceiptUploadV1 = {
      version: RECEIPT_UPLOAD.version,
      uploaderNodeId: options.nodeId,
      role: options.role,
      client: options.client,
      sentAt,
      nonce: nonce(),
      items: cursors.map((cursor) => ({
        receipt: cursor.receipt,
        storedAt: cursor.storedAt,
        startedAt: null,
        offer: null,
      })),
    };
    return JSON.stringify(await signReceiptUpload(upload, options.signer));
  };
}

// Sends once, and on STALE_UPLOAD corrects the clock from the collector's time and resends once.
async function sendCorrected(
  context: UploadContext,
  path: string,
  body: SignedBody,
): Promise<Response | undefined> {
  const sendNow = async () =>
    post(context, path, await body(context.now() + context.offsetMs));
  const response = await sendNow();
  if (response.status !== RECEIPT_UPLOADER_HTTP.conflict) return response;
  const reply = await replyBody(response);
  const serverTime = safeInteger(field(reply, 'serverTime'));
  if (
    field(reply, 'error') !== RECEIPT_UPLOADER_HTTP.staleCode ||
    serverTime === undefined
  )
    return undefined;
  context.offsetMs = serverTime - context.now();
  return sendNow();
}

// Only the collector's own confirmation for exactly these receipts counts as stored.
async function confirmed(response: Response, count: number) {
  const reply = await replyBody(response);
  const receivedAt = safeInteger(field(reply, 'receivedAt'));
  return (
    receivedAt !== undefined &&
    receivedAt > 0 &&
    field(reply, 'accepted') === count
  );
}

async function uploadBatch(
  context: UploadContext,
  cursors: ReceiptUploadCursor[],
): Promise<UploadResult | 'invalid'> {
  const response = await sendCorrected(
    context,
    RECEIPT_UPLOADER.receiptsPath,
    receiptsBody(context, cursors),
  );
  if (!response) return retry();
  if (response.status === RECEIPT_UPLOADER_HTTP.ok) {
    if (!(await confirmed(response, cursors.length))) return retry();
    // Retention uses this node's clock, so the acknowledgement does too.
    const at = context.now();
    for (const cursor of cursors)
      await context.options.store.markUploaded(cursor, at, context.signal);
    return {
      outcome: RECEIPT_UPLOADER_OUTCOMES.UPLOADED,
      uploaded: cursors.length,
    };
  }
  await response.body?.cancel();
  return invalidContent(response.status) ? 'invalid' : retry();
}

// A refused batch is retried one receipt at a time so a single bad receipt is skipped. If every
// receipt is refused the envelope itself is the problem (for example a version the collector does
// not accept): nothing is marked refused and the uploader backs off.
async function attempt(
  context: UploadContext,
  cursors: ReceiptUploadCursor[],
): Promise<UploadResult> {
  const result = await uploadBatch(context, cursors);
  if (result !== 'invalid') return result;
  if (cursors.length === 1) return retry();
  let uploaded = 0;
  const refused: string[] = [];
  for (const cursor of cursors) {
    if (context.signal.aborted) return retry();
    const single = await uploadBatch(context, [cursor]);
    if (single === 'invalid') refused.push(cursor.fingerprint);
    else if (single.outcome === RECEIPT_UPLOADER_OUTCOMES.RETRY) return retry();
    else uploaded += single.uploaded;
  }
  if (!uploaded) return retry();
  for (const fingerprint of refused)
    if (context.refused.size < RECEIPT_UPLOADER.maxRefused)
      context.refused.add(fingerprint);
  return { outcome: RECEIPT_UPLOADER_OUTCOMES.UPLOADED, uploaded };
}

async function uploadReceipts(context: UploadContext): Promise<UploadResult> {
  try {
    const pending = (
      await context.options.store.listPending(
        RECEIPT_UPLOAD.maxItems + context.refused.size,
        context.signal,
      )
    )
      .filter((cursor) => !context.refused.has(cursor.fingerprint))
      .slice(0, RECEIPT_UPLOAD.maxItems);
    if (!pending.length)
      return { outcome: RECEIPT_UPLOADER_OUTCOMES.IDLE, uploaded: 0 };
    return await attempt(context, pending);
  } catch {
    return retry();
  }
}

function observationsBody(
  context: UploadContext,
  events: Record<string, unknown>[],
): SignedBody {
  const { options } = context;
  return async (sentAt) => {
    const upload: ObservationUploadV1 = {
      version: OBSERVATION_UPLOAD.version,
      uploaderNodeId: options.nodeId,
      role: options.role,
      client: options.client,
      sentAt,
      nonce: nonce(),
      events,
    };
    return JSON.stringify(await signObservationUpload(upload, options.signer));
  };
}

// Observations are best effort: a failed send puts them back; a batch the collector refuses as
// invalid is dropped (and counted) so it cannot block later observations.
async function uploadObservations(
  context: UploadContext,
): Promise<UploadResult> {
  const buffer = context.options.observations;
  if (!buffer?.size())
    return { outcome: RECEIPT_UPLOADER_OUTCOMES.IDLE, uploaded: 0 };
  const events = buffer.take(OBSERVATION_UPLOAD.maxEvents);
  try {
    const response = await sendCorrected(
      context,
      RECEIPT_UPLOADER.observationsPath,
      observationsBody(context, events),
    );
    if (
      response?.status === RECEIPT_UPLOADER_HTTP.ok &&
      (await confirmed(response, events.length))
    )
      return {
        outcome: RECEIPT_UPLOADER_OUTCOMES.UPLOADED,
        uploaded: events.length,
      };
    await response?.body?.cancel();
    if (response && invalidContent(response.status))
      return { outcome: RECEIPT_UPLOADER_OUTCOMES.REJECTED, uploaded: 0 };
  } catch {
    /* restored below */
  }
  buffer.restore(events);
  return retry();
}

async function uploadOnce(context: UploadContext): Promise<UploadResult> {
  const receipts = await uploadReceipts(context);
  if (context.signal.aborted) return receipts;
  const observations = await uploadObservations(context);
  const failed =
    receipts.outcome === RECEIPT_UPLOADER_OUTCOMES.RETRY ||
    observations.outcome === RECEIPT_UPLOADER_OUTCOMES.RETRY;
  // A full receipt page keeps the loop going at once; observations follow the regular pace.
  return failed
    ? retry()
    : receipts.uploaded
      ? receipts
      : { outcome: observations.outcome, uploaded: 0 };
}

export function createReceiptUploader(
  options: ReceiptUploaderOptions,
): ReceiptUploader {
  const stop = new AbortController();
  const context: UploadContext = {
    options,
    fetcher: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    baseUrl: options.url,
    signal: stop.signal,
    offsetMs: 0,
    refused: new Set(),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let retryMs: number = RECEIPT_UPLOADER.retryMs;

  function schedule(result: UploadResult) {
    running = undefined;
    if (stop.signal.aborted) return;
    let delay: number = RECEIPT_UPLOADER.tickMs;
    if (result.outcome === RECEIPT_UPLOADER_OUTCOMES.RETRY) {
      delay = retryMs;
      retryMs = Math.min(retryMs * 2, RECEIPT_UPLOADER.maxRetryMs);
    } else {
      retryMs = RECEIPT_UPLOADER.retryMs;
      // A full page means more are waiting: continue right away.
      if (result.uploaded >= RECEIPT_UPLOAD.maxItems) delay = 0;
    }
    timer = setTimeout(tick, delay);
    timer.unref?.();
  }
  function tick() {
    timer = undefined;
    running = uploadOnce(context).then(schedule);
  }

  return {
    uploadOnce: () => uploadOnce(context),
    start() {
      if (stop.signal.aborted || timer || running) return;
      tick();
    },
    // Aborts any upload in flight; receipts not acknowledged stay pending for the next start.
    async close() {
      stop.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
