import { Wallet } from '@phosphor-icons/react';

import { x402Amount } from '../x402-model';
import { fundingAmount } from './BuyerFunding';
import { useBuyerFunding } from './useBuyerFunding';
import type { X402View } from './useX402';

export function ComposerFunding({
  buyer,
  offerId,
}: {
  buyer: X402View;
  offerId?: string;
}) {
  const { policy, summary, error } = buyer.state;
  const { funding } = useBuyerFunding(policy?.payer, offerId);
  return (
    <div className="pk-composer-tab">
      <span className="pk-tab-item" data-network="testnet">
        <span className="pk-dot" aria-hidden="true" />
        Testnet
      </span>
      <span className="pk-tab-item">
        <Wallet size={14} />
        {funding?.balanceAtomic == null
          ? 'Balance unavailable'
          : fundingAmount(funding.balanceAtomic)}
      </span>
      <span className="pk-tab-item pk-tab-limit">
        {policy && !error && summary.active && !summary.blocked
          ? 'Chat limit · ' + x402Amount(summary.limitAtomic, policy)
          : summary.blocked
            ? 'Review payment'
            : 'Chat limit unavailable'}
      </span>
    </div>
  );
}
