// Structural native Iroh ports for reusable sessions and deterministic stream tests.
import type { Connection } from '@number0/iroh';

import type { ControlStream } from './control-io';

export interface BatchDestination {
  id(): { toString(): string };
  relayUrl(): string | null;
}
export interface BatchConnection extends Pick<Connection, 'close' | 'paths'> {
  remoteId(): { toString(): string };
  openBi(): Promise<ControlStream>;
  closed(): Promise<unknown>;
}
export interface BatchEndpoint<Remote extends BatchDestination> {
  id(): { toString(): string };
  connect(remote: Remote, alpn: number[]): Promise<BatchConnection>;
}
