// Only the current main frame may inspect its buyer's public funding state or open the fixed faucet.
import type { PaidChannelEligibility } from '@gyblos/buyer/channel-eligibility';
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import type {
  BuyerApiPolicy,
  BuyerSellerChoice,
} from '@gyblos/protocol/buyer-api';
import { controlHex } from '@gyblos/protocol/control-validation';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { FUNDING, type BuyerFunding } from './model';

interface Sender {
  sender: unknown;
  senderFrame: unknown;
}
interface FundingPorts {
  accepts(event: Sender): boolean;
  policy(): BuyerApiPolicy | null;
  rpcUrl(policy: BuyerApiPolicy): Promise<string | null>;
  balance(payer: string, url: string): Promise<string | null>;
  resolveOffer(id: string): BuyerSellerChoice | undefined;
  switching?(
    policy: BuyerApiPolicy,
    seller: BuyerSellerChoice,
  ): Promise<Pick<
    BuyerFunding,
    'switchingAtomic' | 'replacementAtomic' | 'poolLimited'
  > | null>;
  remaining(
    policy: BuyerApiPolicy,
    seller: BuyerSellerChoice,
    rpcUrl: string,
  ): Promise<PaidChannelEligibility>;
  copy(text: string): void;
  open(url: string): Promise<void>;
}
function coalesceBalance(read: FundingPorts['balance']) {
  let observation:
    { payer: string; url: string; result: Promise<string | null> } | undefined;
  return (payer: string, url: string) => {
    if (observation?.payer === payer && observation.url === url)
      return observation.result;
    const result = read(payer, url).finally(() => {
      if (observation?.result === result) observation = undefined;
    });
    observation = { payer, url, result };
    return result;
  };
}
async function fundingSource(ports: FundingPorts, event: Sender) {
  if (!ports.accepts(event)) return null;
  const policy = ports.policy();
  if (!policy || policy.network !== DEVNET || policy.mint !== DEVNET_USDC)
    return null;
  const url = await ports.rpcUrl(policy);
  const current = () => {
    const latest = ports.policy();
    return (
      ports.accepts(event) &&
      latest?.policyId === policy.policyId &&
      latest.payer === policy.payer &&
      latest.network === policy.network &&
      latest.mint === policy.mint
    );
  };
  return url && current() ? { policy, url, current } : null;
}
async function fundingAction(
  ports: FundingPorts,
  sharedBalance: FundingPorts['balance'],
  event: Sender,
  args: readonly unknown[],
  kind: typeof FUNDING.copy | typeof FUNDING.faucet,
) {
  if (args.length !== 1 || typeof args[0] !== 'string') return false;
  try {
    const target = await fundingSource(ports, event);
    if (!target || target.policy.payer !== args[0]) return false;
    if (kind === FUNDING.copy) ports.copy(target.policy.payer);
    else {
      if (
        (await sharedBalance(target.policy.payer, target.url)) === null ||
        !target.current()
      )
        return false;
      await ports.open(FUNDING.circle);
    }
    return true;
  } catch {
    return false;
  }
}

export function fundingHandlers(ports: FundingPorts) {
  const sharedBalance = coalesceBalance(ports.balance);
  let last:
    { payer: string; url: string; atomic: string; at: number } | undefined;
  return {
    async balance(
      event: Sender,
      args: readonly unknown[],
    ): Promise<BuyerFunding | null> {
      if (args.length > 1) return null;
      try {
        const target = await fundingSource(ports, event);
        if (!target) return null;
        const seller = args.length
          ? ports.resolveOffer(controlHex(args[0]))
          : undefined;
        const [balanceAtomic, channel] = await Promise.all([
          sharedBalance(target.policy.payer, target.url).catch(() => null),
          seller ? ports.remaining(target.policy, seller, target.url) : null,
        ]);
        const switching =
          seller &&
          channel &&
          (channel.blocker === null ||
            channel.blocker === SESSION_CODES.REPLACEMENT_REQUIRED) &&
          channel.channelRemainingAtomic === null
            ? await ports.switching?.(target.policy, seller)
            : null;
        if (!target.current()) return null;
        if (balanceAtomic !== null)
          last = {
            payer: target.policy.payer,
            url: target.url,
            atomic: balanceAtomic,
            at: Date.now(),
          };
        return {
          ...(balanceAtomic === null &&
            last?.payer === target.policy.payer &&
            last.url === target.url && {
              lastBalanceAtomic: last.atomic,
              lastBalanceAt: last.at,
            }),
          payer: target.policy.payer,
          network: DEVNET,
          balanceAtomic,
          faucetAvailable: balanceAtomic !== null,
          channelRemainingAtomic: channel?.channelRemainingAtomic ?? null,
          ...(channel?.channelId && { channelId: channel.channelId }),
          ...(channel?.blocker && { channelBlocker: channel.blocker }),
          ...switching,
        };
      } catch {
        return null;
      }
    },
    copy: (event: Sender, args: readonly unknown[]) =>
      fundingAction(ports, sharedBalance, event, args, FUNDING.copy),
    faucet: (event: Sender, args: readonly unknown[]) =>
      fundingAction(ports, sharedBalance, event, args, FUNDING.faucet),
  };
}
