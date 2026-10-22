// Owns laboratory process/JSON DTOs; it must not depend on product wallets.
// Legacy private Docker JSON keeps its existing parse/rejection behavior.
import type { PathSnapshot } from '@number0/iroh';

import type { NAT } from '@gyblos/lab-p2p/constants';
import type { UdpMapping } from '@gyblos/lab-p2p/nat-mapping';

export interface ProbeOptions {
  'native-image'?: string;
  'lab-candidates'?: boolean;
  'wan-discovery'?: boolean;
  'block-udp'?: boolean;
  'trace-public'?: boolean;
  idle?: boolean;
}
export type ContainerIds = Record<string, string>;
export interface ReflectionConfig {
  observerId: string;
  protocol: string;
  maximumBytes: number;
  timeoutMs: number;
  closeCode: string;
  subnetPrefix: string;
}
export interface ReflectionConnection {
  remoteId(): { toString(): string };
  paths(): { isSelected: boolean; isIp: boolean }[];
  openBi(): Promise<{
    send: { finish(): Promise<void> };
    recv: { readToEnd(maximum: number): Promise<number[]> };
  }>;
  close(code: bigint, reason: number[]): void;
}
export interface ReflectionEndpoint<Observer> {
  connect(
    observer: Observer,
    protocol: number[],
  ): Promise<ReflectionConnection>;
  addExternalAddr(address: string): Promise<void>;
  close(): Promise<void>;
}
export interface ProbeConfig {
  protocol: string;
  bind: string;
  ipv6Bind: string;
  closeCode: string;
  maximumStreams: number;
  samples: number;
  intervalMs: number;
  deadlineMs: number;
  bytes: number;
  peerPath: string;
  resultPath: string;
  active: boolean;
  external?: string;
  discovery?: Omit<ReflectionConfig, 'observerId'> & { descriptorPath: string };
  publicAudit?: typeof NAT.publicAudit;
}
export interface ObserverConfig {
  protocol: string;
  bind: string;
  descriptorPath: string;
  maximumClients: number;
  maximumBytes: number;
  closeCode: string;
}
export interface NativeDescriptor {
  id: string;
  relayUrl: string | null;
  directAddresses: string[];
  boundSockets: string[];
  reflectedAddress: string | null;
}
export interface NativeResult {
  boundSockets: string[];
  reflectedAddress: string | null;
  connectMs: number;
  echoes: number;
  snapshots: { at: number; paths: PathSnapshot[] }[];
  peer: NativeDescriptor;
  localAddresses: string[];
  learnedAddresses?: string[];
}
export type NativeMappings = Record<string, UdpMapping[]>;
export interface ComposeActor {
  depends_on?: object;
  networks: object;
  volumes?: unknown[];
  tmpfs?: string[];
  environment: object;
  command?: string[];
  user?: string;
  cap_drop: string[];
  cap_add?: string[];
  privileged?: boolean;
  network_mode?: string;
  ports?: unknown[];
}
export interface ComposeTemplate {
  services: Record<string, ComposeActor> & { buyer: ComposeActor };
  volumes?: object;
}
export interface ContainerInspection {
  Config: { User: string };
  HostConfig: {
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    PortBindings?: object;
    CapAdd?: string[];
  };
  Mounts: { Type: string }[];
  NetworkSettings: { Networks: object };
}
export interface AuditCounts {
  outbound: number;
  incomingAny: number;
  incomingPeer?: number;
  incomingKnownReturn?: number;
  incomingInput: number;
  incomingForward: number;
}
