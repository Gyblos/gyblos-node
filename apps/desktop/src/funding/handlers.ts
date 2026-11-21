// Only the current main frame may inspect its buyer's public funding state or open the fixed faucet.
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import type {
  BuyerApiPolicy,
  BuyerSellerChoice,
} from '@gyblos/protocol/buyer-api';
import { controlHex } from '@gyblos/protocol/control-validation';

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
  ): Promise<string | null>;
  remaining(
    policy: BuyerApiPolicy,
    seller: BuyerSellerChoice,
  ): Promise<string | null>;
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
export function fundingHandlers(ports: FundingPorts) {
  const sharedBalance = coalesceBalance(ports.balance);
  async function source(event: Sender) {
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
  async function action(
    event: Sender,
    args: readonly unknown[],
    kind: typeof FUNDING.copy | typeof FUNDING.faucet,
  ) {
    if (args.length !== 1 || typeof args[0] !== 'string') return false;
    try {
      const target = await source(event);
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
  return {
    async balance(
      event: Sender,
      args: readonly unknown[],
    ): Promise<BuyerFunding | null> {
      if (args.length > 1) return null;
      try {
        const target = await source(event);
        if (!target) return null;
        const seller = args.length
          ? ports.resolveOffer(controlHex(args[0]))
          : undefined;
        const [balanceAtomic, channelRemainingAtomic] = await Promise.all([
          sharedBalance(target.policy.payer, target.url),
          seller
            ? ports.remaining(target.policy, seller).catch(() => null)
            : null,
        ]);
        const switching =
          seller && channelRemainingAtomic === null
            ? await ports.switching?.(target.policy, seller).catch(() => null)
            : null;
        return target.current()
          ? {
              payer: target.policy.payer,
              network: DEVNET,
              balanceAtomic,
              faucetAvailable: balanceAtomic !== null,
              channelRemainingAtomic,
              ...(switching && { switchingAtomic: switching }),
            }
          : null;
      } catch {
        return null;
      }
    },
    copy: (event: Sender, args: readonly unknown[]) =>
      action(event, args, FUNDING.copy),
    faucet: (event: Sender, args: readonly unknown[]) =>
      action(event, args, FUNDING.faucet),
  };
}
