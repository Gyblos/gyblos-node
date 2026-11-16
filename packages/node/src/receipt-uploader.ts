// Uploads this node's pending signed receipts to the metrics collector in signed envelopes. It never
// blocks or retries inference; a failure keeps receipts pending (the store never evicts them) and
// backs off. A clock the collector rejects is corrected from the collector's reply.
import { RECEIPT_UPLOADER } from '@gyblos/config';
import type { P2PRole } from '@gyblos/protocol/constants';
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
  type ReceiptUploaderOutcome,
} from './constants';
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
    !RECEIPT_UPLOADER_HTTP.retryableClientErrors.has(status)
  );
}

interface UploadContext {
  options: ReceiptUploaderOptions;
  fetcher: typeof fetch;
  now: () => number;
  endpoint: string;
  // Collector time minus this clock, learned from a STALE_UPLOAD reply.
  offsetMs: number;
  // Receipts the collector refused as invalid, skipped for this process so one cannot block the rest.
  refused: Set<string>;
}

async function send(context: UploadContext, cursors: ReceiptUploadCursor[]) {
  const { options } = context;
  const upload: ReceiptUploadV1 = {
    version: RECEIPT_UPLOAD.version,
    uploaderNodeId: options.nodeId,
    role: options.role,
    client: options.client,
    sentAt: context.now() + context.offsetMs,
    nonce: nonce(),
    items: cursors.map((cursor) => ({
      receipt: cursor.receipt,
      storedAt: cursor.storedAt,
      startedAt: null,
      offer: null,
    })),
  };
  const body = JSON.stringify(await signReceiptUpload(upload, options.signer));
  return context.fetcher(context.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(RECEIPT_UPLOADER.requestMs),
  });
}

// Sends once, corrects the clock and resends once on STALE_UPLOAD, and acknowledges on success.
async function sendCorrected(
  context: UploadContext,
  cursors: ReceiptUploadCursor[],
): Promise<Response | undefined> {
  const response = await send(context, cursors);
  if (response.status !== RECEIPT_UPLOADER_HTTP.conflict) return response;
  const reply = await replyBody(response);
  const serverTime = safeInteger(field(reply, 'serverTime'));
  if (
    field(reply, 'error') !== RECEIPT_UPLOADER_HTTP.staleCode ||
    serverTime === undefined
  )
    return undefined;
  context.offsetMs = serverTime - context.now();
  return send(context, cursors);
}

async function attempt(
  context: UploadContext,
  cursors: ReceiptUploadCursor[],
): Promise<UploadResult> {
  const response = await sendCorrected(context, cursors);
  if (response?.status === RECEIPT_UPLOADER_HTTP.ok) {
    const receivedAt =
      safeInteger(field(await replyBody(response), 'receivedAt')) ??
      context.now();
    for (const cursor of cursors)
      await context.options.store.markUploaded(cursor, receivedAt);
    return {
      outcome: RECEIPT_UPLOADER_OUTCOMES.UPLOADED,
      uploaded: cursors.length,
    };
  }
  if (!response || !invalidContent(response.status))
    return { outcome: RECEIPT_UPLOADER_OUTCOMES.RETRY, uploaded: 0 };
  // Retry one by one so a single bad receipt is skipped instead of blocking the batch.
  if (cursors.length > 1) {
    let uploaded = 0;
    for (const cursor of cursors)
      uploaded += (await attempt(context, [cursor])).uploaded;
    return { outcome: RECEIPT_UPLOADER_OUTCOMES.UPLOADED, uploaded };
  }
  context.refused.add(cursors[0]!.fingerprint);
  return { outcome: RECEIPT_UPLOADER_OUTCOMES.REJECTED, uploaded: 0 };
}

async function uploadOnce(context: UploadContext): Promise<UploadResult> {
  try {
    const pending = (
      await context.options.store.listPending(
        RECEIPT_UPLOADER.batch + context.refused.size,
      )
    )
      .filter((cursor) => !context.refused.has(cursor.fingerprint))
      .slice(0, RECEIPT_UPLOADER.batch);
    if (!pending.length)
      return { outcome: RECEIPT_UPLOADER_OUTCOMES.IDLE, uploaded: 0 };
    return await attempt(context, pending);
  } catch {
    return { outcome: RECEIPT_UPLOADER_OUTCOMES.RETRY, uploaded: 0 };
  }
}

export function createReceiptUploader(
  options: ReceiptUploaderOptions,
): ReceiptUploader {
  const context: UploadContext = {
    options,
    fetcher: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    endpoint: `${options.url}${RECEIPT_UPLOADER.receiptsPath}`,
    offsetMs: 0,
    refused: new Set(),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let closed = false;
  let retryMs: number = RECEIPT_UPLOADER.retryMs;

  function schedule(result: UploadResult) {
    running = undefined;
    if (closed) return;
    let delay: number = RECEIPT_UPLOADER.tickMs;
    if (result.outcome === RECEIPT_UPLOADER_OUTCOMES.RETRY) {
      delay = retryMs;
      retryMs = Math.min(retryMs * 2, RECEIPT_UPLOADER.maxRetryMs);
    } else {
      retryMs = RECEIPT_UPLOADER.retryMs;
      // A full page means more are waiting: continue right away.
      if (result.uploaded >= RECEIPT_UPLOADER.batch) delay = 0;
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
      if (closed || timer || running) return;
      tick();
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await running;
    },
  };
}
