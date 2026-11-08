// Contract for the offline SDK/native-program acceptance fixture. No RPC or product startup.
import type { UptoChannelOnChain, UptoSettlement } from 'x402-upto-metered';

export interface NativeBalances {
  payer: bigint;
  seller: bigint;
  fee: bigint;
  program: bigint;
  escrow: bigint;
}

export interface NativeChannel {
  expiresAt: number;
  sends(): number;
  open(): Promise<void>;
  close(): Promise<void>;
  claim(amount: string): Promise<UptoSettlement>;
  balances(): Promise<NativeBalances>;
  channel(): Promise<UptoChannelOnChain | undefined>;
  atInclusion(seconds: number): void;
  time(seconds: number): void;
  loseConfirmation(value: boolean): void;
  failureCode(): number | undefined;
  refund(): Promise<void>;
  replay(): Promise<boolean>;
}

export async function nativeChannel(_options: {
  now: () => number;
  grace?: number;
}): Promise<NativeChannel | undefined> {
  return undefined;
}
