// Reads upto channels for a seller's chain through a minimal RPC: whether its own channel exists, and
// whether one of its claim attempts landed or the channel was sealed for another amount. Decoding and
// the canonical-address check are the SDK's. No Gyblos imports; no writes.
import {
  address,
  signature as asSignature,
  type Address,
  type Signature,
} from '@solana/kit';
import { discoverChannelsByRentPayer } from '@x402/svm';

import { UPTO_CHANNEL_ACCOUNT, UPTO_COMMITMENT } from './constants';
import type { UptoTerms } from './types';

export interface UptoChannelAccount {
  owner: string;
  data: [string, 'base64'];
}

export interface UptoChannelRpc {
  getAccountInfo(channelId: string): Promise<UptoChannelAccount | null>;
  // Per signature, in order: whether it confirmed without error (false when the chain does not know it).
  signaturesSucceeded(signatures: readonly string[]): Promise<boolean[]>;
}

const SEALED: readonly number[] = [
  UPTO_CHANNEL_ACCOUNT.statuses.SEALED,
  UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED,
];

export function createUptoChannelReaders(
  rpc: UptoChannelRpc,
  options: { network: UptoTerms['network']; rentPayer: Address },
) {
  // This seller's channel at its canonical address, or undefined for anything else there.
  async function decoded(channelId: string) {
    const account = await rpc.getAccountInfo(channelId);
    if (!account) return undefined;
    const [found] = await discoverChannelsByRentPayer(
      {
        getProgramAccounts: async () => [
          {
            pubkey: address(channelId),
            account: { ...account, owner: address(account.owner) },
          },
        ],
      },
      options.network,
      options.rentPayer,
    );
    return found?.channelId === channelId &&
      found.channel.rentPayer === options.rentPayer
      ? found.channel
      : undefined;
  }
  return {
    // Only this seller's channel counts: any other account at the address (a plain transfer
    // creates one) is not a landed deposit.
    async channelExists(channelId: string): Promise<boolean> {
      return (await decoded(channelId)) !== undefined;
    },
    async settledClaim(
      channelId: string,
      claim: { chargedAtomic: string; attempts: readonly string[] },
    ): Promise<{ transaction: string; chargedAtomic: string } | undefined> {
      // Our own claim transaction carries our voucher for this charge; it stays on record even
      // after rent cleanup closes the channel.
      if (claim.attempts.length) {
        const succeeded = await rpc.signaturesSucceeded(claim.attempts);
        const landed = claim.attempts.find(
          (_signature, index) => succeeded[index],
        );
        if (landed)
          return { transaction: landed, chargedAtomic: claim.chargedAtomic };
      }
      const channel = await decoded(channelId);
      if (!channel || !SEALED.includes(channel.status)) return undefined;
      const settled = String(channel.settlement.settled);
      // Sealed for our charge by a transaction we cannot name: unknown, so the claim stays
      // unavailable rather than reporting a guessed transaction.
      if (settled === claim.chargedAtomic) return undefined;
      return { transaction: '', chargedAtomic: settled };
    },
  };
}

// The slice of a @solana/kit RPC the readers use, so any kit RPC (or a test double) fits.
export interface UptoKitRpc {
  getAccountInfo(
    channel: Address,
    config: { encoding: 'base64'; commitment: typeof UPTO_COMMITMENT },
  ): {
    send(): Promise<{
      value: { owner: Address; data: readonly [string, 'base64'] } | null;
    }>;
  };
  getSignatureStatuses(
    signatures: Signature[],
    config: { searchTransactionHistory: true },
  ): {
    send(): Promise<{
      value: readonly ({
        err: unknown;
        confirmationStatus: string | null;
      } | null)[];
    }>;
  };
}

const CONFIRMED: readonly (string | null)[] =
  UPTO_CHANNEL_ACCOUNT.landedStatuses;

export function uptoChannelRpc(rpc: UptoKitRpc): UptoChannelRpc {
  return {
    async getAccountInfo(channelId) {
      const { value } = await rpc
        .getAccountInfo(address(channelId), {
          encoding: 'base64',
          commitment: UPTO_COMMITMENT,
        })
        .send();
      return value
        ? { owner: String(value.owner), data: [value.data[0], 'base64'] }
        : null;
    },
    async signaturesSucceeded(signatures) {
      const { value } = await rpc
        .getSignatureStatuses(
          signatures.map((sent) => asSignature(sent)),
          { searchTransactionHistory: true },
        )
        .send();
      return signatures.map((_signature, index) => {
        const status = value[index];
        return (
          !!status &&
          status.err === null &&
          CONFIRMED.includes(status.confirmationStatus)
        );
      });
    },
  };
}
