// Reads the upto channel account through a minimal RPC: whether it exists, and, once a claim sealed it,
// the settled amount and the sealing transaction (the first successful one after the open). Decoding
// and the canonical-address check are the SDK's; anything else is not reported as sealed.
import { address, type Address } from '@solana/kit';
import { discoverChannelsByRentPayer } from '@x402/svm';

import { UPTO_CHANNEL_ACCOUNT, UPTO_ERROR_CODES } from './constants';
import { UptoError } from './errors';
import type { UptoTerms } from './types';

export interface UptoChannelAccount {
  owner: string;
  data: [string, 'base64'];
}

export interface UptoChannelRpc {
  getAccountInfo(channelId: string): Promise<UptoChannelAccount | null>;
  // Newest first, as the chain returns them, at most UPTO_CHANNEL_ACCOUNT.signatureLimit.
  getSignatures(
    channelId: string,
  ): Promise<{ signature: string; failed: boolean }[]>;
}

const SEALED: readonly number[] = [
  UPTO_CHANNEL_ACCOUNT.statuses.SEALED,
  UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED,
];

// The open created the account, so the first successful transaction after it is the seal.
function sealingTransaction(
  newestFirst: { signature: string; failed: boolean }[],
): string {
  const [, seal] = newestFirst.filter((entry) => !entry.failed).reverse();
  if (!seal) throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  return seal.signature;
}

export function createUptoChannelReaders(
  rpc: UptoChannelRpc,
  options: { network: UptoTerms['network']; rentPayer: Address },
) {
  async function decoded(channelId: string) {
    const account = await rpc.getAccountInfo(channelId);
    if (!account) return undefined;
    // The SDK checks the owner program, the layout and the canonical address of this rent payer.
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
    async channelExists(channelId: string): Promise<boolean> {
      return (await rpc.getAccountInfo(channelId)) !== null;
    },
    async settledClaim(
      channelId: string,
    ): Promise<{ transaction: string; chargedAtomic: string } | undefined> {
      const channel = await decoded(channelId);
      if (!channel || !SEALED.includes(channel.status)) return undefined;
      return {
        transaction: sealingTransaction(await rpc.getSignatures(channelId)),
        chargedAtomic: String(channel.settlement.settled),
      };
    },
  };
}

// The slice of a @solana/kit RPC the readers use, so any kit RPC (or a test double) fits.
export interface UptoKitRpc {
  getAccountInfo(
    channel: Address,
    config: { encoding: 'base64'; commitment: 'confirmed' },
  ): {
    send(): Promise<{
      value: { owner: Address; data: readonly [string, 'base64'] } | null;
    }>;
  };
  getSignaturesForAddress(
    channel: Address,
    config: { limit: number; commitment: 'confirmed' },
  ): {
    send(): Promise<readonly { signature: string; err: unknown }[]>;
  };
}

export function uptoChannelRpc(rpc: UptoKitRpc): UptoChannelRpc {
  return {
    async getAccountInfo(channelId) {
      const { value } = await rpc
        .getAccountInfo(address(channelId), {
          encoding: 'base64',
          commitment: 'confirmed',
        })
        .send();
      return value
        ? { owner: String(value.owner), data: [value.data[0], 'base64'] }
        : null;
    },
    async getSignatures(channelId) {
      const entries = await rpc
        .getSignaturesForAddress(address(channelId), {
          limit: UPTO_CHANNEL_ACCOUNT.signatureLimit,
          commitment: 'confirmed',
        })
        .send();
      return entries.map((entry) => ({
        signature: String(entry.signature),
        failed: entry.err !== null,
      }));
    },
  };
}
