// HTTP message, route observation and Transport interface shared by buyer and seller sides.
import { TRANSPORT_ROUTES } from './constants.js';

export type TransportRoute =
  (typeof TRANSPORT_ROUTES)[keyof typeof TRANSPORT_ROUTES];

export interface HttpMessage {
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpRequest extends HttpMessage {
  method: string;
  path: string;
}

export interface HttpResponse extends HttpMessage {
  status: number;
}

export interface RouteObservation {
  transport: TransportRoute;
  connectMs: number;
  directObserved: boolean;
  relayObserved: boolean;
}

export interface Transport {
  kind: 'loopback' | 'iroh';
  exchange(request: HttpRequest): Promise<HttpResponse & RouteObservation>;
  close(): Promise<void>;
}
