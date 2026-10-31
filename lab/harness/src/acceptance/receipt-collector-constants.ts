// Fixed lab-only storage and subprocess bounds; no product path or network service is configured.
export const COLLECTOR_ACCEPTANCE = {
  directory: 'collector-acceptance',
  httpSnapshot: 'http-retained.json',
  httpBytes: 256,
  httpRetentionMs: 100,
  snapshot: 'receipts.json',
  boundedSnapshot: 'bounded.json',
  worker: 'receipt-collector-worker.ts',
  restartMs: 10000,
  killMs: 1000,
  reportBytes: 256,
  concurrency: 2,
  refusals: 3,
} as const;
export interface CollectorAcceptanceReport {
  collectorHttp: true;
  collectorStored: number;
  collectorDuplicates: number;
  collectorRestarts: number;
  collectorRefusals: number;
}
