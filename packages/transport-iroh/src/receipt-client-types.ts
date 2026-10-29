// Minimal structural ports for native receipt I/O and deterministic fakes; no SDK construction at import.
import type { Connection } from '@number0/iroh';

import type { ControlStream } from './control-io';

export interface ReceiptDestination {
  id(): { toString(): string };
  relayUrl(): string | null;
}
export interface ReceiptConnection extends Pick<
  Connection,
  'close' | 'closeReason' | 'paths'
> {
  remoteId(): { toString(): string };
  openBi(): Promise<ControlStream>;
}
export interface ReceiptEndpoint<Remote extends ReceiptDestination> {
  id(): { toString(): string };
  connect(remote: Remote, alpn: number[]): Promise<ReceiptConnection>;
}
