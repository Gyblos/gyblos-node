import Link from 'next/link';

import { getTransactionTable } from '../lib/chain-txs';
import { operationHref, txRow } from '../lib/chain-txs-shape';
import { PAGES, PAGING } from '../lib/constants';
import type { OfferedModel } from '../lib/discovery';
import { getDiscovery } from '../lib/discovery-render';
import { count, pricePerMtok, utc } from '../lib/format';
import { modelKey } from '../lib/offers';
import { rangeOf, tablePager, type ExplorerQuery } from '../lib/paging';
import {
  emptySellersMessage,
  githubByNode,
  namesByNode,
  sellerHref,
  verifiedOnly,
} from '../lib/seller-identity';
import { OperationChip } from './channel-txs';
import { pagedRows, Pager } from './pager';
import { SellerCell } from './seller-cell';
import {
  Addr,
  EmptyRow,
  ModelName,
  moneyCell,
  numberCell,
  prefixedColumn,
  SectionTitle,
  Table,
  td,
  timeCell,
  Unavailable,
} from './ui';

const OFFERS = 'Current offers';
const OPERATIONS = 'Latest operations';
const OFFERS_HEAD = [
  prefixedColumn('Model / variant', 'model'),
  prefixedColumn('Seller', 'seller'),
  { label: 'Context', right: true, sort: 'context' },
  {
    label: 'Input',
    group: 'USDC / 1M tokens',
    right: true,
    sort: 'input',
    ascendingFirst: true,
  },
  {
    label: 'Output',
    group: 'USDC / 1M tokens',
    right: true,
    sort: 'output',
    ascendingFirst: true,
  },
];
const sortOffers = {
  context: ({ model }: { model: OfferedModel }) => model.contextTokens,
  input: ({ model }: { model: OfferedModel }) =>
    BigInt(model.pricing.inputAtomicPerMtok),
  output: ({ model }: { model: OfferedModel }) =>
    BigInt(model.pricing.outputAtomicPerMtok),
};
const OPERATION_HEAD = [
  { label: 'Time (UTC)' },
  prefixedColumn('Type', 'operation'),
  { label: 'USDC', right: true },
  { label: 'Signature' },
];

function TableTitle({
  id,
  title,
  href,
  label,
}: {
  id: string;
  title: string;
  href: string;
  label: string;
}) {
  return (
    <SectionTitle
      id={id}
      title={title}
      meta={
        <Link className="hover:text-ink" href={href}>
          {label} →
        </Link>
      }
    />
  );
}

function OfferTerms({ model }: { model: OfferedModel }) {
  return (
    <>
      <td className={numberCell}>{count(model.contextTokens)}</td>
      <td className={moneyCell}>
        {pricePerMtok(model.pricing.inputAtomicPerMtok)}
      </td>
      <td className={moneyCell}>
        {pricePerMtok(model.pricing.outputAtomicPerMtok)}
      </td>
    </>
  );
}

export async function OverviewOffers({ query }: { query: ExplorerQuery }) {
  const snapshot = await getDiscovery();
  if (snapshot.error)
    return <Unavailable title={OFFERS} anchors={[PAGING.anchors.sellers]} />;
  const accounts = githubByNode(snapshot.network);
  const names = namesByNode(snapshot.network);
  const sellers = query.verified
    ? verifiedOnly(snapshot.sellers, accounts)
    : snapshot.sellers;
  const rows = sellers.flatMap((seller) =>
    seller.models.map((model) => ({ seller, model })),
  );
  const models = new Set(rows.map(({ model }) => modelKey(model))).size;
  const known = !!snapshot.network && !snapshot.network.truncated;
  const page = pagedRows(
    query,
    'sellers',
    rows,
    !query.verified || known,
    sortOffers,
  );
  const days = rangeOf(query, 'overview');
  return (
    <section>
      <TableTitle
        id={PAGING.anchors.sellers}
        title={OFFERS}
        href={PAGES.models}
        label="All models"
      />
      <p className="text-sm text-muted">
        {count(models)} {models === 1 ? 'model' : 'models'} ·{' '}
        {count(sellers.length)} {query.verified ? 'verified ' : ''}
        {sellers.length === 1 ? 'seller' : 'sellers'} online · Updated{' '}
        {utc(snapshot.datedAt ?? snapshot.generatedAt)}
      </p>
      <Table
        head={OFFERS_HEAD}
        sorting={{ query, table: 'sellers' }}
        footer={
          <Pager label={OFFERS} view={tablePager(query, 'sellers', page)} />
        }
      >
        {page.rows.map(({ seller, model }) => (
          <tr
            key={seller.nodeId + modelKey(model)}
            className="border-t border-line"
          >
            <td className={td}>
              <ModelName {...model} days={days} closed />
            </td>
            <td className={td}>
              <SellerCell
                nodeId={seller.nodeId}
                github={accounts.get(seller.nodeId) ?? null}
                name={names.get(seller.nodeId)}
                href={sellerHref(seller.nodeId, {
                  ...query,
                  days,
                  closed: true,
                })}
              >
                <Addr value={seller.owner} />
              </SellerCell>
            </td>
            <OfferTerms model={model} />
          </tr>
        ))}
        {!rows.length && (
          <EmptyRow columns={OFFERS_HEAD.length}>
            {emptySellersMessage(sellers, query.verified, known) ??
              'No current offers.'}
          </EmptyRow>
        )}
      </Table>
    </section>
  );
}

export async function OverviewOperations({ query }: { query: ExplorerQuery }) {
  const page = await getTransactionTable(query);
  if (page.error)
    return (
      <Unavailable title={OPERATIONS} anchors={[PAGING.anchors.transactions]} />
    );
  return (
    <section>
      <TableTitle
        id={PAGING.anchors.transactions}
        title={OPERATIONS}
        href={PAGES.transactions}
        label="All transactions"
      />
      <Table
        head={OPERATION_HEAD}
        footer={<Pager label={OPERATIONS} view={page.pager} />}
      >
        {page.transactions.map((tx) => {
          const row = txRow(tx, new Map(), page.treasury);
          return (
            <tr key={row.key} className="border-t border-line">
              <td className={timeCell}>{row.time}</td>
              <td className={td}>
                <OperationChip kind={row.kind} />
              </td>
              <td className={row.muted ? numberCell : moneyCell}>
                {row.amount}
              </td>
              <td className={td}>
                <Link
                  className="font-mono underline decoration-line underline-offset-2 hover:decoration-current"
                  href={operationHref(tx)}
                  title={tx.signature}
                >
                  {row.signature}
                </Link>
              </td>
            </tr>
          );
        })}
        {!page.transactions.length && (
          <EmptyRow columns={OPERATION_HEAD.length}>
            No channel transactions.
          </EmptyRow>
        )}
      </Table>
    </section>
  );
}
