// Observation upload envelope contract: a node signs a batch of its own content-free telemetry
// events (for example a buyer's unserved demand or experienced latency). Event semantics are validated
// by the collector with core's telemetry projection; this contract owns shape, bounds and signature.
import { canonicalJson } from './canonical';
import { CONTROL_CODES, CONTROL_LIMITS } from './constants';
import {
  controlArray,
  controlFail,
  controlHex,
  controlInteger,
  controlObject,
  controlVerify,
} from './control-validation';
import type {
  ObservationUploadV1,
  SignedObservationUpload,
} from './observation-upload-types';
import { OBSERVATION_UPLOAD } from './observation-upload/constants';
import { bytesHex, hexBytes } from './public-validation';
import {
  parseUploadClient,
  parseUploadRole,
  uploadClientRole,
} from './receipt-upload-parser';
import { sign, type Signer } from './signing';

export type * from './observation-upload-types';
export { OBSERVATION_UPLOAD } from './observation-upload/constants';

// A plain JSON object, detached; nested values are copied through canonical JSON.
function event(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return controlFail();
  const input = controlObject(value, Object.keys(value));
  let text: string;
  try {
    // Canonical JSON refuses unsafe or fractional numbers and non-JSON values with a plain error.
    text = canonicalJson(input);
  } catch {
    return controlFail();
  }
  const copy: unknown = JSON.parse(text);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy))
    return controlFail();
  return Object.fromEntries(Object.entries(copy));
}

export function parseObservationUpload(value: unknown): ObservationUploadV1 {
  if (!value || typeof value !== 'object') return controlFail();
  const input = controlObject(value, [
    'version',
    'uploaderNodeId',
    'role',
    'client',
    'sentAt',
    'nonce',
    'events',
  ]);
  if (input.version !== OBSERVATION_UPLOAD.version)
    return controlFail(CONTROL_CODES.VERSION);
  const uploaderNodeId = controlHex(input.uploaderNodeId);
  const role = parseUploadRole(input.role);
  const client = parseUploadClient(input.client);
  if (uploadClientRole(client.kind) !== role) return controlFail();
  const raw = controlArray(input.events, OBSERVATION_UPLOAD.maxEvents);
  if (!raw.length) return controlFail();
  const upload: ObservationUploadV1 = {
    version: OBSERVATION_UPLOAD.version,
    uploaderNodeId,
    role,
    client,
    sentAt: controlInteger(input.sentAt),
    nonce: controlHex(input.nonce, OBSERVATION_UPLOAD.nonceBytes),
    events: raw.map(event),
  };
  if (
    new TextEncoder().encode(canonicalJson(upload)).byteLength >
    OBSERVATION_UPLOAD.maxBytes
  )
    return controlFail(CONTROL_CODES.LIMIT);
  return upload;
}

export async function signObservationUpload(
  value: ObservationUploadV1,
  signer: Signer,
): Promise<SignedObservationUpload> {
  const upload = parseObservationUpload(value);
  const signature = Uint8Array.from(
    await sign(OBSERVATION_UPLOAD.domain, upload, signer),
  );
  if (
    signature.length !== CONTROL_LIMITS.signatureBytes ||
    !(await controlVerify(
      OBSERVATION_UPLOAD.domain,
      upload,
      hexBytes(upload.uploaderNodeId),
      signature,
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { upload, signature: bytesHex(signature) };
}

// Parses, detaches and checks the uploader's signature. Event semantics are the caller's to validate.
export async function verifyObservationUpload(
  value: unknown,
): Promise<SignedObservationUpload> {
  const input = controlObject(value, ['upload', 'signature']);
  const upload = parseObservationUpload(input.upload);
  const signature = controlHex(input.signature, CONTROL_LIMITS.signatureBytes);
  if (
    !(await controlVerify(
      OBSERVATION_UPLOAD.domain,
      upload,
      hexBytes(upload.uploaderNodeId),
      hexBytes(signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { upload, signature };
}
