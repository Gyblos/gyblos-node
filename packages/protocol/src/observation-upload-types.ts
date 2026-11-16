// Types of the uploader-signed envelope of content-free telemetry events (observations).
import type { P2PRole } from './constants';
import type { OBSERVATION_UPLOAD } from './observation-upload/constants';
import type { ReceiptUploadClient } from './receipt-upload-types';

export interface ObservationUploadV1 {
  version: typeof OBSERVATION_UPLOAD.version;
  uploaderNodeId: string;
  role: P2PRole;
  client: ReceiptUploadClient;
  sentAt: number;
  nonce: string;
  // Telemetry event records (core's validated projection). The collector validates each one and
  // binds it to the uploader; this contract only bounds and detaches them.
  events: Record<string, unknown>[];
}
export interface SignedObservationUpload {
  upload: ObservationUploadV1;
  signature: string;
}
