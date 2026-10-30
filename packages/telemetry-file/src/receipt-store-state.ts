// Holds one explicit store lifecycle; no process-global collector state, paths or timers.
import type { FileHandle } from 'node:fs/promises';

import type { PrivateFreeReceipt } from '@gyblos/core/receipt-collector';
import type { ProcessLock } from '@gyblos/runtime/private-file';

export interface ReceiptFileSettings {
  path: string;
  maxEntries: number;
  maxBytes: number;
  maxPending: number;
}
export interface ReceiptFileState {
  settings: ReceiptFileSettings;
  parent: FileHandle;
  lock: ProcessLock;
  text: string;
  entries: PrivateFreeReceipt[];
  tail: Promise<void>;
  pending: number;
  closed: boolean;
  broken: boolean;
}
