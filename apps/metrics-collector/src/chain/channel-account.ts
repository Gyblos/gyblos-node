// Owns how a payment channel account (256 bytes, base64 from getMultipleAccounts) is read: its status,
// deposit, settled cumulative amount and payout watermark. A missing account was reclaimed (closed).
import {
  CHAIN_CHANNEL_CLOSED,
  CHAIN_CHANNEL_STATUSES,
  CHAIN_LAYOUT,
} from '../constants';
import { ChainShapeError } from './json';

export interface ChannelState {
  status: string;
  depositAtomic: bigint | null;
  settledAtomic: bigint | null;
  payoutAtomic: bigint | null;
}

export function channelState(base64: string | null): ChannelState {
  if (base64 === null)
    return {
      status: CHAIN_CHANNEL_CLOSED,
      depositAtomic: null,
      settledAtomic: null,
      payoutAtomic: null,
    };
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  if (bytes.length !== CHAIN_LAYOUT.channelAccountBytes)
    throw new ChainShapeError('channel account size');
  const view = new DataView(bytes.buffer);
  const status = CHAIN_CHANNEL_STATUSES[bytes[CHAIN_LAYOUT.channelStatusAt]!];
  if (!status) throw new ChainShapeError('channel status');
  return {
    status,
    depositAtomic: view.getBigUint64(CHAIN_LAYOUT.channelDepositAt, true),
    settledAtomic: view.getBigUint64(CHAIN_LAYOUT.channelSettledAt, true),
    payoutAtomic: view.getBigUint64(CHAIN_LAYOUT.channelPayoutAt, true),
  };
}
