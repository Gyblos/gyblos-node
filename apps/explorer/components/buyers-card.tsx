import { Users } from 'lucide-react';

import type { NetworkBuyers } from '../lib/collector';
import { buyersText, newBuyersText } from '../lib/usage';
import { StatCard } from './board/stat-card';

export function BuyersCard({
  buyers,
  days,
  variant,
}: {
  buyers: NetworkBuyers | null;
  days: number;
  variant?: 'footer' | 'plain';
}) {
  const side = (figure: 'free' | 'paid') =>
    buyers ? buyersText(buyers[figure].allTime) : '—';
  return (
    <StatCard
      variant={variant}
      icon={Users}
      label="Buyers, all time"
      hint="Distinct buyers up to the end of yesterday, UTC: free buyers by NodeId, paid buyers by wallet, never added together. Counts below 5 are shown as < 5."
      sides={{ free: side('free'), paid: side('paid') }}
      caption={newBuyersText(buyers, days)}
    />
  );
}
