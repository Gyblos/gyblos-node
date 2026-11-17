// Owns the observation upload envelope version, signing domain and bounds; separate from receipts.
export const OBSERVATION_UPLOAD = {
  version: 1,
  domain: 'gyblos/observation-upload/v1\n',
  // Content-free telemetry events per envelope; the uploader batches beyond this.
  maxEvents: 200,
  nonceBytes: 16,
  // Canonical bytes of the parsed `upload` object.
  maxBytes: 262_144,
} as const;
