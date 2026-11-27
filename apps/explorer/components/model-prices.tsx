import { count, pricePerMtok, usdcDecimal } from '../lib/format';
import { priceDays, type PriceSpread } from '../lib/model-page';
import type { OfferPriceHistory } from '../lib/offer-price-history';
import { BarChartCard } from './board/bar-chart-card';

const SIDES = ['input', 'output'] as const;

const spreadText = (spread: PriceSpread, sellers: number) =>
  sellers > 1
    ? `${pricePerMtok(String(spread.min))} – ${pricePerMtok(String(spread.max))} across ${count(sellers)} sellers`
    : 'one seller';

export function ModelPrices({ history }: { history: OfferPriceHistory }) {
  const days = priceDays(history.series, history.from, history.to);
  if (!days.some((day) => day.sellers)) return null;
  const latest = [...days].reverse().find((day) => day.sellers);
  return (
    <div className="mb-6 grid min-w-0 gap-3 md:grid-cols-3">
      {SIDES.map((side) => (
        <BarChartCard
          key={side}
          title={`Median ${side} · USDC / 1M`}
          kind="usdc"
          countAxis={false}
          total={latest?.[side] ? usdcDecimal(latest[side].median) : null}
          summary="Across sellers, per UTC day"
          startAtEnd
          points={days.map((day) => {
            const spread = day[side];
            return {
              day: day.day,
              value: spread ? Number(spread.median) : null,
              amount: spread ? usdcDecimal(spread.median) : null,
              detail: spread ? spreadText(spread, day.sellers) : undefined,
            };
          })}
        />
      ))}
      <BarChartCard
        title="Sellers offering it"
        kind="count"
        total={latest ? latest.sellers : null}
        summary="With an offer, per UTC day"
        startAtEnd
        points={days.map((day) => ({
          day: day.day,
          value: day.sellers,
          amount: day.sellers,
        }))}
      />
    </div>
  );
}
