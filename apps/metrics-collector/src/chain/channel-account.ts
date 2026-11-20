// Owns how a payment channel account (from getMultipleAccounts) is read: its status, deposit, settled
// cumulative amount and payout watermark. A missing account was reclaimed (closed); an account another
// program owns, or of another size, holds no channel (unknown). Never throws on chain content.
import { CHANNEL_PROGRAM } from '@gyblos/config/network';

import {
  CHAIN_CHANNEL_CLOSED,
  CHAIN_CHANNEL_STATUSES,
  CHAIN_CHANNEL_UNKNOWN,
  CHAIN_LAYOUT,
} from '../constants';
import type { ChainAccount } from './rpc';

export interface ChannelState {
  status: string;
  depositAtomic: bigint | null;
  settledAtomic: bigint | null;
  payoutAtomic: bigint | null;
}
const withoutAmounts = (status: string): ChannelState => ({
  status,
  depositAtomic: null,
  settledAtomic: null,
  payoutAtomic: null,
});

export function channelState(account: ChainAccount | null): ChannelState {
  if (account === null) return withoutAmounts(CHAIN_CHANNEL_CLOSED);
  if (account.owner !== CHANNEL_PROGRAM)
    return withoutAmounts(CHAIN_CHANNEL_UNKNOWN);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(account.data), (char) => char.charCodeAt(0));
  } catch {
    return withoutAmounts(CHAIN_CHANNEL_UNKNOWN);
  }
  const status =
    CHAIN_CHANNEL_STATUSES[bytes[CHAIN_LAYOUT.channelStatusAt] ?? -1];
  if (bytes.length !== CHAIN_LAYOUT.channelAccountBytes || !status)
    return withoutAmounts(CHAIN_CHANNEL_UNKNOWN);
  const view = new DataView(bytes.buffer);
  return {
    status,
    depositAtomic: view.getBigUint64(CHAIN_LAYOUT.channelDepositAt, true),
    settledAtomic: view.getBigUint64(CHAIN_LAYOUT.channelSettledAt, true),
    payoutAtomic: view.getBigUint64(CHAIN_LAYOUT.channelPayoutAt, true),
  };
}
