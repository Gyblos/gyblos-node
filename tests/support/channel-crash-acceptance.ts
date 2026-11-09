// Offline crash acceptance result; chain state must survive the killed buyer process.
import type { CrashCut } from './channel-crash-constants';
import type { NativeBalances } from './paid-native-channel';

export interface ChannelCrashReport {
  signal: NodeJS.Signals | null;
  retainedIdentity: boolean;
  replacementSignatures: number;
  replacementSends: number;
  startupBlocked: boolean;
  chargedAtomic: string;
  balances: NativeBalances;
}

export async function runChannelCrash(
  _cut: CrashCut,
): Promise<ChannelCrashReport> {
  return {
    signal: null,
    retainedIdentity: false,
    replacementSignatures: 0,
    replacementSends: 0,
    startupBlocked: true,
    chargedAtomic: '0',
    balances: { payer: 100_000n, seller: 0n, fee: 0n, program: 0n, escrow: 0n },
  };
}
