import { ALL_TIME, RANGE } from '../lib/constants';
import type { OfferedModel } from '../lib/discovery-shape';
import { usdcDecimal, utcMinute } from '../lib/format';
import { modelKey } from '../lib/offers';
import { rangeEnd, rangeQuery, type RangeDays } from '../lib/range';
import { inclusiveDates } from '../lib/stats-window';
import {
  integerText,
  list,
  nullable,
  num,
  record,
  text,
} from '../lib/validate';
import { BarChartCard } from './board/bar-chart-card';
import { SellerCell } from './seller-cell';
import { ModelName, SectionTitle } from './ui';

type Identity = Pick<OfferedModel, 'modelId' | 'variant' | 'quantization'>;

function readSample(value: unknown) {
  const row = record(value, 'price sample');
  const optional = (field: unknown) =>
    nullable(field, (value) => text(value, 'model field'));
  return {
    nodeId: text(row.nodeId, 'node'),
    modelId: text(row.modelId, 'model'),
    variant: optional(row.variant),
    quantization: optional(row.quantization),
    day: text(row.day, 'day'),
    input: BigInt(integerText(row.input, 'input')),
    output: BigInt(integerText(row.output, 'output')),
    receipts: num(row.receipts, 'receipts'),
  };
}

type Sample = ReturnType<typeof readSample>;

function PriceSeries({ rows, dates }: { rows: Sample[]; dates: string[] }) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const latest = rows.at(-1);
  if (!latest) return null;
  return (
    <div className="mt-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <SellerCell nodeId={latest.nodeId} github={null} />
        <ModelName {...latest} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['input', 'output'] as const).map((side) => (
          <BarChartCard
            key={side}
            title={
              side === 'input'
                ? 'Input · USDC / 1M tokens'
                : 'Output · USDC / 1M tokens'
            }
            kind="usdc"
            countAxis={false}
            total={usdcDecimal(latest[side])}
            points={dates.map((day) => {
              const row = byDay.get(day);
              return {
                day,
                value: row ? Number(row[side]) : null,
                amount: row ? usdcDecimal(row[side]) : null,
                detail: row ? `${row.receipts} paid receipts` : undefined,
              };
            })}
          />
        ))}
      </div>
    </div>
  );
}

export function ReceiptPriceHistory({
  model,
  nodeId,
  days,
}: {
  model?: Identity;
  nodeId?: string;
  days: RangeDays;
}) {
  const raw = process.env.GYBLOS_PREVIEW_RECEIPT_PRICES;
  if (process.env.NODE_ENV !== 'development' || !raw) return null;
  const snapshot = record(JSON.parse(raw), 'price extract');
  const asOf = text(snapshot.asOf, 'extract time');
  const all = list(snapshot.rows, 'rates')
    .map(readSample)
    .sort((left, right) => left.day.localeCompare(right.day));
  const end = rangeEnd(days, Date.now());
  const bounds =
    days === ALL_TIME ? null : new URLSearchParams(rangeQuery(days, end));
  const from = bounds?.get('from') ?? all[0]?.day;
  const to = bounds?.get('to') ?? asOf.slice(0, RANGE.dayPrecision);
  const dates = from ? inclusiveDates(from, to) : [];
  const groups = new Map<string, Sample[]>();
  for (const row of all) {
    if (
      !from ||
      row.day < from ||
      row.day > to ||
      (nodeId && row.nodeId !== nodeId) ||
      (model && modelKey(row) !== modelKey(model))
    )
      continue;
    const key = JSON.stringify([row.nodeId, modelKey(row)]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return (
    <section id="price-history">
      <SectionTitle
        title="Observed price history"
        meta={`Solana devnet · Paid receipts through ${utcMinute(Date.parse(asOf))} UTC`}
      />
      <p className="text-sm text-muted">
        Latest observed rate per UTC day. Gaps mark days without a paid receipt
        in this sample.
      </p>
      {groups.size ? (
        Array.from(groups, ([key, rows]) => (
          <PriceSeries key={key} rows={rows} dates={dates} />
        ))
      ) : (
        <p className="mt-3 text-sm text-muted">
          No paid prices observed in this period.
        </p>
      )}
    </section>
  );
}
