'use client';

import { useState } from 'react';

import { count, short, usdcDecimal, utcMinute } from '../lib/format';
import type { getOfferPriceHistory } from '../lib/offer-price-history';
import { BarChartCard } from './board/bar-chart-card';
import { Select } from './board/select';
import { SellerCell } from './seller-cell';
import { ModelName } from './ui';

type Series = Awaited<
  ReturnType<typeof getOfferPriceHistory>
>['series'][number];

export function OfferPriceCharts({
  series,
  bySeller,
}: {
  series: Series[];
  bySeller: boolean;
}) {
  const [key, setKey] = useState('');
  const selected = series.find((item) => item.key === key) ?? series[0];
  const latest = selected?.points.at(-1);
  if (!selected || !latest) return null;
  const options = series.map((item) => ({
    id: item.key,
    label: [
      bySeller
        ? short(item.nodeId)
        : [item.modelId, item.variant, item.quantization]
            .filter(Boolean)
            .join(' '),
      count(item.contextTokens) + ' ctx',
    ].join(' · '),
  }));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {bySeller ? (
          <SellerCell nodeId={selected.nodeId} github={null} />
        ) : (
          <ModelName {...selected} />
        )}
        {options.length > 1 ? (
          <Select
            size="sm"
            label={bySeller ? 'Seller and context' : 'Model and context'}
            options={options}
            selected={selected.key}
            onChange={setKey}
          />
        ) : (
          <span className="text-xs text-muted">
            {count(selected.contextTokens)} context tokens
          </span>
        )}
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {(['input', 'output'] as const).map((side) => (
          <BarChartCard
            key={selected.key + side}
            title={
              (side === 'input' ? 'Input' : 'Output') + ' · USDC / 1M tokens'
            }
            kind="usdc"
            countAxis={false}
            total={usdcDecimal(latest[side])}
            summary={`Latest quoted rate · ${selected.points.length} offer ${selected.points.length === 1 ? 'period' : 'periods'}`}
            points={selected.points.map((point) => {
              const [band, tick] = utcMinute(point.at).split(' ');
              return {
                day: new Date(point.at).toISOString(),
                band,
                tick,
                amount: usdcDecimal(point[side]),
                value: Number(point[side]),
                detail: 'Through ' + utcMinute(point.end) + ' UTC',
              };
            })}
          />
        ))}
      </div>
    </>
  );
}
