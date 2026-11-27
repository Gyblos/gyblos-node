import { Wallet } from '@phosphor-icons/react';

import type { BuyerFunding } from '../funding/model';
import { x402Amount } from '../x402-model';
import { fundingAmount } from './BuyerFunding';
import { InlineSpinner } from './UI';
import type { X402View } from './useX402';

export function ComposerFunding({
  buyer,
  balanceStatus,
  checking,
  funding,
}: {
  buyer: X402View;
  balanceStatus: string;
  checking: boolean;
  funding: BuyerFunding | null;
}) {
  const { policy, summary, error } = buyer.state;
  const matchingBudget =
    !!policy && summary.policy?.policyId === policy.policyId;
  return (
    <div className="pk-composer-tab">
      <span className="pk-tab-item" data-network="testnet">
        <span className="pk-dot" aria-hidden="true" />
        Testnet
      </span>
      <span className="pk-tab-item" aria-live="polite" aria-busy={checking}>
        <Wallet size={14} aria-hidden="true" />
        {checking ? (
          <>
            <InlineSpinner />
            Checking balance…
          </>
        ) : funding?.balanceAtomic == null ? (
          'Balance · ' + balanceStatus
        ) : (
          <>
            <span className="sr-only">Balance · last checked · </span>
            {fundingAmount(funding.balanceAtomic)}
          </>
        )}
      </span>
      <span className="pk-tab-item pk-tab-limit">
        {matchingBudget &&
        !error &&
        summary.available &&
        summary.active &&
        !summary.blocked
          ? 'Chat limit · ' + x402Amount(summary.limitAtomic, policy)
          : summary.blocked || (summary.active && !matchingBudget)
            ? 'Review payment'
            : 'Chat limit unavailable'}
      </span>
    </div>
  );
}
