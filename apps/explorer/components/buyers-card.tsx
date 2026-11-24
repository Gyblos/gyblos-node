import { Users } from 'lucide-react';

import type { NetworkBuyers } from '../lib/collector';
import { DISPLAY } from '../lib/constants';
import { buyersText, newBuyersText } from '../lib/usage';
import { StatCard } from './board/stat-card';

const MIN = DISPLAY.minPublicBuyers;

export function BuyersCard({
  buyers,
  days,
  variant,
  className,
}: {
  buyers: NetworkBuyers | null;
  days: number;
  variant?: 'footer' | 'plain';
  className: string;
}) {
  const side = (figure: 'free' | 'paid') =>
    buyersText(buyers?.[figure].allTime ?? null);
  return (
    <div className={`row-span-4 grid grid-rows-subgrid gap-y-0 ${className}`}>
      <StatCard
        variant={variant}
        icon={Users}
        label="Buyers, all time"
        hint={`Distinct buyers up to the end of yesterday, UTC: free buyers by NodeId, paid buyers by wallet (or by NodeId when the receipt names no wallet), never added together. A buyer counts from its first receipt reported by the seller and not disputed by the buyer, and stays counted if that receipt is disputed later. New: that first receipt falls in the range. Counts below ${MIN} are shown as < ${MIN}.`}
        sides={{ free: side('free'), paid: side('paid') }}
        caption={newBuyersText(buyers, days)}
      />
    </div>
  );
}
