import { pricePerMtok, usdcDecimal } from '../lib/format';
import { priceDays, type PriceSpread } from '../lib/model-page';
import type { OfferPriceHistory } from '../lib/offer-price-history';
import { BarChartCard } from './board/bar-chart-card';

const SIDES = ['input', 'output'] as const;

const spreadText = (spread: PriceSpread) =>
  spread.min === spread.max
    ? 'one paid price'
    : `${pricePerMtok(String(spread.min))} – ${pricePerMtok(String(spread.max))} paid`;

export function ModelPrices({ history }: { history: OfferPriceHistory }) {
  const starts = history.series.flatMap((item) =>
    item.points.map((point) => point.at),
  );
  const knownFrom =
    history.truncated && starts.length ? Math.min(...starts) : history.from;
  const days = priceDays(history.series, history.from, history.to, knownFrom);
  if (!days.some((day) => day.sellers)) return null;
  const latest = days.at(-1);
  return (
    <div className="mb-6 grid min-w-0 gap-3 lg:grid-cols-3">
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
              detail: spread ? spreadText(spread) : undefined,
            };
          })}
        />
      ))}
      <BarChartCard
        title="Sellers offering it"
        kind="count"
        total={latest?.sellers ?? null}
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
