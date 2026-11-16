// Owns one observation upload's acceptance, cheapest checks first: strict JSON, envelope parse and
// signature, the clock window, per-node admission, then each event validated by core and bound to the
// uploader, the shared write budget and one atomic write.
import { toTelemetryRecord } from '@gyblos/core/telemetry';
import { canonicalJson } from '@gyblos/protocol';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { verifyObservationUpload } from '@gyblos/protocol/observation-upload';
import {
  TELEMETRY_EVENTS,
  type TelemetryEvent,
} from '@gyblos/protocol/telemetry';

import {
  COLLECTOR_ERRORS,
  COLLECTOR_LIMITS,
  ENVELOPE_KINDS,
} from './constants';
import { collectorReject, verificationFailure } from './errors';
import {
  decode,
  envelopeId,
  StaleUploadError,
  type IngestContext,
  type IngestResult,
} from './ingest';
import { COMMIT_RESULTS, type ObservationRow } from './storage';

interface ValidatedEvent {
  type: string;
  at: number;
  role: string;
  requestId: string | null;
  buyerNodeId: string;
  sellerNodeId: string | null;
  modelId: string;
  record: object;
}

function text(record: object, key: string) {
  const value: unknown = Reflect.get(record, key);
  return typeof value === 'string' ? value : collectorReject();
}
function nullableText(record: object, key: string) {
  const value: unknown = Reflect.get(record, key);
  return value === null ? null : text(record, key);
}

// Core's projection validates every declared field and detaches it; receipts use their own envelope.
function validated(value: unknown): ValidatedEvent {
  let record: object;
  try {
    // The projection reads only declared own data properties of the untrusted value and validates
    // each one, so the static type here is a reading contract, not an assumption.
    record = toTelemetryRecord(value as TelemetryEvent);
  } catch (error) {
    return verificationFailure(error);
  }
  // Exactly the validated projection: an undeclared field (for example a prompt) is refused, never
  // silently dropped, because the signed envelope is stored verbatim.
  if (canonicalJson(record) !== canonicalJson(value))
    return collectorReject(COLLECTOR_ERRORS.INVALID_UPLOAD);
  const type = text(record, 'type');
  if (type === TELEMETRY_EVENTS.RECEIPT)
    return collectorReject(COLLECTOR_ERRORS.UPLOAD_POLICY);
  const at: unknown = Reflect.get(record, 'at');
  const selection: unknown = Reflect.get(record, 'selection');
  return {
    type,
    at: typeof at === 'number' ? at : collectorReject(),
    role: text(record, 'role'),
    requestId: nullableText(record, 'requestId'),
    buyerNodeId: text(record, 'buyerNodeId'),
    sellerNodeId: nullableText(record, 'sellerNodeId'),
    modelId:
      selection && typeof selection === 'object'
        ? text(selection, 'modelId')
        : collectorReject(),
    record,
  };
}

export async function ingestObservations(
  bytes: Uint8Array,
  context: IngestContext,
): Promise<IngestResult> {
  if (bytes.byteLength > COLLECTOR_LIMITS.maxBodyBytes)
    return collectorReject(COLLECTOR_ERRORS.PAYLOAD_TOO_LARGE);
  let signed;
  try {
    signed = await verifyObservationUpload(decode(bytes));
  } catch (error) {
    return verificationFailure(error);
  }
  const { upload, signature } = signed;
  if (Math.abs(context.now - upload.sentAt) > COLLECTOR_LIMITS.clockWindowMs)
    throw new StaleUploadError(context.now);
  if (!(await context.admitNode(upload.uploaderNodeId)))
    return collectorReject(COLLECTOR_ERRORS.RATE_LIMITED);
  const id = await envelopeId(signature);
  const rows: ObservationRow[] = upload.events.map((value, index) => {
    const event = validated(value);
    // Each event must be the uploader's own, in its role.
    const party =
      upload.role === P2P_ROLES.SELLER
        ? event.sellerNodeId === upload.uploaderNodeId
        : event.buyerNodeId === upload.uploaderNodeId;
    if (event.role !== upload.role || !party)
      return collectorReject(COLLECTOR_ERRORS.UPLOAD_POLICY);
    return {
      index,
      type: event.type,
      at: event.at,
      requestId: event.requestId,
      sellerNodeId: event.sellerNodeId,
      modelId: event.modelId,
      json: canonicalJson(event.record),
    };
  });
  if (!(await context.admitWrite()))
    return collectorReject(COLLECTOR_ERRORS.RATE_LIMITED);
  const result = await context.storage.commitObservations(
    {
      envelope: {
        id,
        kind: ENVELOPE_KINDS.OBSERVATIONS,
        uploaderNodeId: upload.uploaderNodeId,
        role: upload.role,
        client: upload.client,
        sentAt: upload.sentAt,
        nonce: upload.nonce,
        itemCount: upload.events.length,
        signature,
        json: canonicalJson({ upload, signature }),
        receivedAt: context.now,
      },
      events: rows,
    },
    context.now,
  );
  if (result === COMMIT_RESULTS.REPLAYED)
    return collectorReject(COLLECTOR_ERRORS.REPLAYED_UPLOAD);
  return { receivedAt: context.now, accepted: rows.length };
}
