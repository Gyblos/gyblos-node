// Owns the Models section: one row per model as published, with what is offered now (sellers, lowest
// paid prices, context) next to what was served over the range (completed requests, cancellations, the
// first token as the seller and the buyer measured it, and the engine's speed), free and paid apart.
import { getCollector } from '../lib/collector';
import { DISPLAY, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import {
  count,
  latencyMs,
  percent,
  tokensPerSecond,
  usdc,
  utc,
} from '../lib/format';
import {
  completion,
  modelRows,
  type ModelRow,
  type Served,
} from '../lib/model-table';
import { summarizeOffers } from '../lib/offers';
import { rangeOf, tablePager, type ExplorerQuery } from '../lib/paging';
import { displayRange } from '../lib/range';
import { pagedRows, Pager } from './pager';
import {
  ModelName,
  moneyCell,
  numberCell,
  SectionTitle,
  SideCells,
  sideColumns,
  Table,
  td,
  Unavailable,
  type Column,
} from './ui';

function completedText(side: Served | null) {
  if (!side) return '—';
  const { done, of, ratio } = completion(side);
  return ratio === null
    ? '—'
    : `${count(done)} of ${count(of)} (${percent(ratio)})`;
}

// The lowest paid input and output prices per million tokens (money), or "Free" when only free
// sellers offer it now.
function PriceCells({ now }: { now: ModelRow['now'] }) {
  if (!now || now.minInput === null || now.minOutput === null)
    return (
      <td className={`${numberCell} text-center`} colSpan={2}>
        {now?.free ? 'Free' : '—'}
      </td>
    );
  return (
    <>
      <td className={moneyCell}>{usdc(now.minInput)}</td>
      <td className={moneyCell}>{usdc(now.minOutput)}</td>
    </>
  );
}
const orDash = (show: (value: number) => string) => (value: number | null) =>
  value === null ? '—' : show(value);

const MODELS_HEAD: Column[] = [
  { label: 'Model' },
  ...sideColumns('Sellers now'),
  {
    label: 'Input',
    right: true,
    group: 'Lowest paid / 1M',
    sort: 'input',
  },
  {
    label: 'Output',
    right: true,
    group: 'Lowest paid / 1M',
    sort: 'output',
  },
  { label: 'Max context', right: true, sort: 'context' },
  ...sideColumns('Completed'),
  ...sideColumns('Cancelled'),
  ...sideColumns('Seller first token p50'),
  ...sideColumns('Buyer first token p50'),
  ...sideColumns('Engine speed p50'),
];
const MODEL_SORTS = {
  input: (row: ModelRow) => row.now?.minInput,
  output: (row: ModelRow) => row.now?.minOutput,
  context: (row: ModelRow) => row.now?.context,
};

export async function ModelsSection({ query }: { query: ExplorerQuery }) {
  const days = rangeOf(query, 'models');
  const [discovery, collector] = await Promise.all([
    getDiscovery(),
    getCollector(days),
  ]);
  if (discovery.error && collector.error)
    return <Unavailable title="Models" anchors={[PAGING.anchors.models]} />;
  const offersKnown = !discovery.error;
  const rows = modelRows(
    offersKnown ? summarizeOffers(discovery).models : new Map(),
    collector.error ? [] : collector.models,
  );
  const page = pagedRows(
    query,
    'models',
    rows,
    offersKnown && !collector.error,
    MODEL_SORTS,
  );
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.models}
        title="Models"
        meta={`Offered now · Recorded activity, ${displayRange(days)}`}
        range={{ section: 'models', days }}
      />
      <Table
        minWidth={DISPLAY.modelsTable}
        sorting={{ query, table: 'models' }}
        head={MODELS_HEAD}
        footer={
          <Pager label="Models" view={tablePager(query, 'models', page)} />
        }
      >
        {rows.length ? null : (
          <tr>
            <td className={`${td} text-muted`} colSpan={16}>
              No model offered now or served in the range.
            </td>
          </tr>
        )}
        {page.rows.map((row) => (
          <ModelRowView
            days={days}
            key={`${row.modelId}:${row.variant}:${row.quantization}`}
            row={row}
            offersKnown={offersKnown}
          />
        ))}
      </Table>
      {discovery.datedAt ? (
        <p className="mt-1 text-xs text-dim">
          Offers as of {utc(discovery.datedAt)}.
        </p>
      ) : null}
      {offersKnown ? null : (
        <p className="mt-1 text-xs text-dim">
          The discovery index could not be read: what is offered now is unknown.
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
  days,
  row,
  offersKnown,
}: {
  days: ExplorerQuery['days'];
  row: ModelRow;
  offersKnown: boolean;
}) {
  return (
    <tr className="border-t border-line">
      <td className={td}>
        <ModelName
          days={days}
          modelId={row.modelId}
          variant={row.variant}
          quantization={row.quantization}
        />
      </td>
      {row.now ? (
        <SideCells
          free={row.now.free}
          paid={row.now.sellers - row.now.free}
          show={count}
        />
      ) : (
        <td className={`${numberCell} text-center`} colSpan={2}>
          {offersKnown ? 'Not offered now' : '—'}
        </td>
      )}
      <PriceCells now={row.now} />
      <td className={numberCell}>{row.now ? count(row.now.context) : '—'}</td>
      <SideCells free={row.free} paid={row.paid} show={completedText} />
      <SideCells
        free={row.free?.cancelled ?? null}
        paid={row.paid?.cancelled ?? null}
        show={orDash(count)}
      />
      <SideCells
        free={row.free?.firstToken ?? null}
        paid={row.paid?.firstToken ?? null}
        show={latencyMs}
      />
      <SideCells
        free={row.free?.buyerFirstToken ?? null}
        paid={row.paid?.buyerFirstToken ?? null}
        show={latencyMs}
      />
      <SideCells
        free={row.free?.engineSpeed ?? null}
        paid={row.paid?.engineSpeed ?? null}
        show={tokensPerSecond}
      />
    </tr>
  );
}
