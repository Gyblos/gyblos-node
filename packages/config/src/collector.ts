// Operator value: the metrics collector base URL (the apps/metrics-collector Worker) and the uploader's
// pacing. Release builds always upload; a build without GYBLOS_VERSION uploads only when a URL is set.
export const COLLECTOR_URL = 'https://collector.gyblos.com/v1';

export const RECEIPT_UPLOADER = {
  urlEnvironment: 'GYBLOS_COLLECTOR_URL',
  // Set by the release build; its presence turns uploading on with the default URL.
  releaseEnvironment: 'GYBLOS_VERSION',
  tickMs: 60_000,
  requestMs: 15_000,
  retryMs: 60_000,
  maxRetryMs: 3_600_000,
  // Refused receipts skipped per process; with a full envelope (50) it stays within the store's
  // page limit of 256.
  maxRefused: 200,
  receiptsPath: '/receipts',
  observationsPath: '/observations',
} as const;
