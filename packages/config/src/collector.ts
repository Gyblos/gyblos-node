export const COLLECTOR_URL = 'https://collector.gyblos.com/v1';

export const RECEIPT_UPLOADER = {
  urlEnvironment: 'GYBLOS_COLLECTOR_URL',
  observationsEnvironment: 'GYBLOS_OBSERVATIONS',
  observationsOff: 'off',
  releaseEnvironment: 'GYBLOS_VERSION',
  tickMs: 60_000,
  requestMs: 15_000,
  // On close, how long to keep sending what only this process holds (buffered observations, then
  // pending receipts) before stopping. A one-shot CLI or a quitting app would otherwise lose the
  // observations of its last requests, which wait for the next 60-second tick.
  closeFlushMs: 3_000,
  retryMs: 60_000,
  maxRetryMs: 3_600_000,
  maxRefused: 200,
  receiptsPath: '/receipts',
  observationsPath: '/observations',
} as const;
