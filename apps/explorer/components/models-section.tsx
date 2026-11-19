// Owns the Models section: one row per model as published, with what is offered now (sellers, lowest
// paid prices, context) next to what was served over the range (completed requests, cancellations and
// the seller-measured first token), free and paid apart.
import { getCollector } from '../lib/collector';
import { DISPLAY } from '../lib/constants';
import { getDiscovery } from '../lib/discovery';
import { count, latencyMs, percent, usdc } from '../lib/format';
import {
  completion,
  modelRows,
  type ModelRow,
  type Served,
} from '../lib/model-table';
import { summarizeOffers } from '../lib/offers';
import type { RangeDays } from '../lib/range';
import { pair } from '../lib/usage';
import {
  ModelName,
  moneyCell,
  numberCell,
  SectionTitle,
  Table,
  td,
  Unavailable,
} from './ui';

// "18 of 20 · 90%"; "—" without receipts on that side.
function completedText(side: Served | null) {
  if (!side) return '—';
  const { done, of, ratio } = completion(side);
  return ratio === null
    ? `0 of 0`
    : `${count(done)} of ${count(of)} · ${percent(ratio)}`;
}

// The lowest paid prices per million tokens, or "Free" when only free sellers offer it now.
function priceText(now: ModelRow['now']) {
  if (!now) return '—';
  if (now.minInput === null || now.minOutput === null)
    return now.free ? 'Free' : '—';
  return `${usdc(now.minInput)} · ${usdc(now.minOutput)}`;
}

export async function ModelsSection({ days }: { days: RangeDays }) {
  const [discovery, collector] = await Promise.all([
    getDiscovery(),
    getCollector(days),
  ]);
  if (discovery.error && collector.error) return <Unavailable title="Models" />;
  const rows = modelRows(
    discovery.error ? new Map() : summarizeOffers(discovery).models,
    collector.error ? [] : collector.models,
  );
  return (
    <>
      <SectionTitle
        title="Models"
        meta={`offered now · served over ${days} days`}
      />
      <Table
        minWidth={DISPLAY.modelsTable}
        head={[
          { label: 'Model' },
          { label: 'Sellers now free · paid', right: true },
          { label: 'Lowest input · output / 1M', right: true },
          { label: 'Max context', right: true },
          { label: 'Completed free', right: true },
          { label: 'Completed paid', right: true },
          { label: 'Cancelled free · paid', right: true },
          { label: 'First token p50 free · paid', right: true },
        ]}
      >
        {rows.map((row) => (
          <tr
            key={`${row.modelId}:${row.variant}:${row.quantization}`}
            className="border-t border-line"
          >
            <td className={td}>
              <ModelName
                modelId={row.modelId}
                variant={row.variant}
                quantization={row.quantization}
              />
            </td>
            <td className={numberCell}>
              {row.now
                ? pair(row.now.free, row.now.sellers - row.now.free, count)
                : 'Not offered'}
            </td>
            <td className={row.now?.minInput != null ? moneyCell : numberCell}>
              {priceText(row.now)}
            </td>
            <td className={numberCell}>
              {row.now ? count(row.now.context) : '—'}
            </td>
            <td className={numberCell}>{completedText(row.free)}</td>
            <td className={numberCell}>{completedText(row.paid)}</td>
            <td className={numberCell}>
              {pair(row.free?.cancelled, row.paid?.cancelled, (value) =>
                value === undefined ? '—' : count(value),
              )}
            </td>
            <td className={numberCell}>
              {pair(
                row.free?.firstToken ?? null,
                row.paid?.firstToken ?? null,
                latencyMs,
              )}
            </td>
          </tr>
        ))}
      </Table>
      <p className="mt-2 text-xs text-dim">
        Completed counts the requests that ended without failing; cancellations
        are shown apart and are not failures. First token is measured by the
        seller. Prices are the lowest paid offer now.
      </p>
    </>
  );
}
