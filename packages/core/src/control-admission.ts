// Tracks proposed control quotas with a caller-supplied monotonic clock; no timers, sockets or global state.
import { CONTROL_CAPACITY, CONTROL_CODES } from '@gyblos/protocol/constants';
import { controlFail, controlHex } from '@gyblos/protocol/control-validation';

interface Bucket {
  tokens: number;
  updated: number;
}
interface PeerState {
  connections: number;
  queries: number;
  bucket: Bucket;
  touched: number;
}
interface QueryState {
  peer: PeerState;
  deadline: number;
  active: boolean;
  cancelled: boolean;
  connection: ConnectionState;
}
interface ConnectionState {
  peer: PeerState;
  active: boolean;
  touched: number;
  queries: Set<QueryState>;
}
export interface ControlQueryLease {
  check(): void;
  finish(): void;
  cancel(): void;
  publish<T>(value: T): T;
}
export interface ControlConnectionLease {
  check(): void;
  beginQuery(): ControlQueryLease;
  close(): void;
}
export class ControlAdmission {
  private readonly peers = new Map<string, PeerState>();
  private readonly connections = new Set<ConnectionState>();
  private readonly queries = new Set<QueryState>();
  private readonly global: Bucket;
  private lastNow: number;
  constructor(private readonly clock: () => number) {
    this.lastNow = clock();
    if (!Number.isFinite(this.lastNow) || this.lastNow < 0) controlFail();
    this.global = {
      tokens: CONTROL_CAPACITY.globalBurst,
      updated: this.lastNow,
    };
  }
  private now() {
    const now = this.clock();
    if (!Number.isFinite(now) || now < this.lastNow) return controlFail();
    this.lastNow = now;
    this.sweep(now);
    return now;
  }
  private release(query: QueryState, cancelled: boolean, now: number) {
    if (!query.active) return;
    query.active = false;
    query.cancelled = cancelled;
    query.peer.queries--;
    query.peer.touched = now;
    query.connection.touched = now;
    query.connection.queries.delete(query);
    this.queries.delete(query);
  }
  private close(connection: ConnectionState, now: number) {
    if (!connection.active) return;
    for (const query of connection.queries) this.release(query, true, now);
    connection.active = false;
    connection.peer.connections--;
    connection.peer.touched = now;
    this.connections.delete(connection);
  }
  private sweep(now: number) {
    for (const query of this.queries)
      if (now >= query.deadline) this.release(query, true, now);
    for (const connection of this.connections)
      if (
        !connection.queries.size &&
        now - connection.touched >= CONTROL_CAPACITY.connectionIdleMs
      )
        this.close(connection, now);
    for (const [id, peer] of this.peers)
      if (
        !peer.connections &&
        !peer.queries &&
        now - peer.touched >= CONTROL_CAPACITY.peerIdleMs
      )
        this.peers.delete(id);
  }
  private refill(bucket: Bucket, rate: number, burst: number, now: number) {
    bucket.tokens = Math.min(
      burst,
      bucket.tokens +
        ((now - bucket.updated) * rate) /
          CONTROL_CAPACITY.millisecondsPerSecond,
    );
    bucket.updated = now;
  }
  private consume(peer: PeerState, now: number) {
    this.refill(
      this.global,
      CONTROL_CAPACITY.globalRate,
      CONTROL_CAPACITY.globalBurst,
      now,
    );
    this.refill(
      peer.bucket,
      CONTROL_CAPACITY.peerRate,
      CONTROL_CAPACITY.peerBurst,
      now,
    );
    // Every attempted query consumes global allowance, including malformed and peer-limited queries.
    if (this.global.tokens < 1) return controlFail(CONTROL_CODES.LIMIT);
    this.global.tokens--;
    if (peer.bucket.tokens < 1) return controlFail(CONTROL_CODES.LIMIT);
    peer.bucket.tokens--;
    peer.touched = now;
  }
  openConnection(peerId: string): ControlConnectionLease {
    controlHex(peerId);
    const now = this.now();
    if (this.connections.size >= CONTROL_CAPACITY.connections)
      return controlFail(CONTROL_CODES.LIMIT);
    let peer = this.peers.get(peerId);
    if (!peer) {
      if (this.peers.size >= CONTROL_CAPACITY.peers)
        return controlFail(CONTROL_CODES.LIMIT);
      peer = {
        connections: 0,
        queries: 0,
        touched: now,
        bucket: { tokens: CONTROL_CAPACITY.peerBurst, updated: now },
      };
      this.peers.set(peerId, peer);
    }
    if (peer.connections >= CONTROL_CAPACITY.connectionsPerPeer)
      return controlFail(CONTROL_CODES.LIMIT);
    peer.connections++;
    peer.touched = now;
    const connection: ConnectionState = {
      peer,
      active: true,
      touched: now,
      queries: new Set(),
    };
    this.connections.add(connection);
    return {
      check: () => this.checkConnection(connection),
      beginQuery: () => this.beginQuery(connection),
      close: () => this.close(connection, this.now()),
    };
  }
  private checkConnection(connection: ConnectionState) {
    this.now();
    if (!connection.active) return controlFail(CONTROL_CODES.CANCELLED);
  }
  private beginQuery(connection: ConnectionState): ControlQueryLease {
    this.checkConnection(connection);
    const now = this.now();
    this.consume(connection.peer, now);
    if (
      this.queries.size >= CONTROL_CAPACITY.queries ||
      connection.peer.queries >= CONTROL_CAPACITY.queriesPerPeer
    )
      return controlFail(CONTROL_CODES.LIMIT);
    const query: QueryState = {
      peer: connection.peer,
      connection,
      deadline: now + CONTROL_CAPACITY.queryMs,
      active: true,
      cancelled: false,
    };
    connection.peer.queries++;
    connection.touched = now;
    connection.queries.add(query);
    this.queries.add(query);
    const check = () => {
      this.now();
      if (!query.active || !connection.active)
        return controlFail(CONTROL_CODES.CANCELLED);
    };
    return {
      check,
      finish: () => this.release(query, false, this.now()),
      cancel: () => this.release(query, true, this.now()),
      publish: <T>(value: T) => {
        check();
        this.release(query, false, this.now());
        return value;
      },
    };
  }
}
