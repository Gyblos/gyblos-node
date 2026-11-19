// Owns the Models section: one row per model as published, with what is offered now (sellers, lowest
// paid prices, context) next to what was served over the range (completed requests, cancellations, the
// first token as the seller and the buyer measured it, and the engine's speed), free and paid apart.
import { getCollector } from '../lib/collector';
import { DISPLAY } from '../lib/constants';
import { getDiscovery } from '../lib/discovery';
import {
  count,
  latencyMs,
  percent,
  tokensPerSecond,
  usdc,
} from '../lib/format';
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

// "18 of 20 · 90%"; "—" without receipts on that side, or with cancellations only.
function completedText(side: Served | null) {
  if (!side) return '—';
  const { done, of, ratio } = completion(side);
  return ratio === null
    ? '—'
    : `${count(done)} of ${count(of)} · ${percent(ratio)}`;
}

// The lowest paid input and output prices per million tokens (money), or "Free" when only free
// sellers offer it now.
function price(now: ModelRow['now']): { text: string; money: boolean } {
  if (!now) return { text: '—', money: false };
  if (now.minInput === null || now.minOutput === null)
    return { text: now.free ? 'Free' : '—', money: false };
  return {
    text: `${usdc(now.minInput)} · ${usdc(now.minOutput)}`,
    money: true,
  };
}

export async function ModelsSection({ days }: { days: RangeDays }) {
  const [discovery, collector] = await Promise.all([
    getDiscovery(),
    getCollector(days),
  ]);
  if (discovery.error && collector.error) return <Unavailable title="Models" />;
  const offersKnown = !discovery.error;
  const rows = modelRows(
    offersKnown ? summarizeOffers(discovery).models : new Map(),
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
          { label: 'Lowest paid input · output / 1M', right: true },
          { label: 'Max context', right: true },
          { label: 'Completed free', right: true },
          { label: 'Completed paid', right: true },
          { label: 'Cancelled free · paid', right: true },
          { label: 'Seller first token p50 free · paid', right: true },
          { label: 'Buyer first token p50 free · paid', right: true },
          { label: 'Engine speed p50 free · paid', right: true },
        ]}
      >
        {rows.length ? null : (
          <tr>
            <td className={`${td} text-muted`} colSpan={10}>
              No model offered now or served in the range.
            </td>
          </tr>
        )}
        {rows.map((row) => (
          <ModelRowView
            key={`${row.modelId}:${row.variant}:${row.quantization}`}
            row={row}
            offersKnown={offersKnown}
          />
        ))}
      </Table>
      <p className="mt-2 text-xs text-dim">
        Completed is out of the requests that completed or failed; cancellations
        are shown apart and are not failures. Seller first token is measured by
        the seller. Buyer first token is measured by the buyer on streaming
        requests, from the attempt with the chosen seller (after quotes) to the
        first token, including local payment, tokenizer startup and channel
        setup. Engine speed is output tokens per second of generation, only from
        engines that report their generation time, shown as the lower bound of
        the median. In those two columns, — means no data. The lowest paid input
        and output prices may come from different sellers.
      </p>
      {offersKnown ? null : (
        <p className="mt-1 text-xs text-dim">
          The discovery index did not answer: what is offered now is unknown.
        </p>
      )}
      {collector.error ? (
        <p className="mt-1 text-xs text-dim">
          The metrics collector did not answer: what was served is unknown.
        </p>
      ) : null}
    </>
  );
}

// One model: what is offered now, then what was served on each side. Without the discovery index's
// answer, what is offered now reads unknown, never "not offered".
function ModelRowView({
  row,
  offersKnown,
}: {
  row: ModelRow;
  offersKnown: boolean;
}) {
  const shown = price(row.now);
  return (
    <tr className="border-t border-line">
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
          : offersKnown
            ? 'Not offered now'
            : '—'}
      </td>
      <td className={shown.money ? moneyCell : numberCell}>{shown.text}</td>
      <td className={numberCell}>{row.now ? count(row.now.context) : '—'}</td>
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
      <td className={numberCell}>
        {pair(
          row.free?.buyerFirstToken ?? null,
          row.paid?.buyerFirstToken ?? null,
          latencyMs,
        )}
      </td>
      <td className={numberCell}>
        {pair(
          row.free?.engineSpeed ?? null,
          row.paid?.engineSpeed ?? null,
          tokensPerSecond,
        )}
      </td>
    </tr>
  );
}
