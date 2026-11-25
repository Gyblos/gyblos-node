import { utcMinute } from '../lib/format';
import type { getOfferPriceHistory } from '../lib/offer-price-history';
import { OfferPriceCharts } from './offer-price-charts';
import { SectionTitle, Unavailable } from './ui';

type History = Awaited<ReturnType<typeof getOfferPriceHistory>>;

export function OfferPriceHistory({
  history,
  bySeller = false,
}: {
  history: History;
  bySeller?: boolean;
}) {
  const title = 'Published offer prices';
  if (history.error)
    return <Unavailable title={title} anchors={['price-history']} />;
  return (
    <section id="price-history">
      <SectionTitle
        title={title}
        meta={utcMinute(history.from) + ' – ' + utcMinute(history.to) + ' UTC'}
      />
      {history.series.length ? (
        <OfferPriceCharts series={history.series} bySeller={bySeller} />
      ) : (
        <p className="text-sm text-muted">
          No indexed USDC offers in this period.
        </p>
      )}
      {history.truncated && (
        <p className="mt-2 text-xs text-muted">
          The index returned a partial history for this window.
        </p>
      )}
    </section>
  );
}
