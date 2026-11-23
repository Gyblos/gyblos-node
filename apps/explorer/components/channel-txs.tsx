import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { getChainTxs } from '../lib/chain-txs';
import { sellerOwners, txRow } from '../lib/chain-txs-shape';
import { explorerAddressUrl, PAYMENT_PROGRAM_SOURCE_URL } from '../lib/config';
import { DISPLAY, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { short } from '../lib/format';
import { txPager, type ExplorerQuery } from '../lib/paging';
import { sellerHref } from '../lib/seller-identity';
import { Pager } from './pager';
import {
  Addr,
  moneyCell,
  numberCell,
  SectionTitle,
  Table,
  td,
  timeCell,
  Unavailable,
} from './ui';

const TITLE = 'Channel transactions';
const link = 'inline-flex items-center gap-1 hover:text-brand';
const muted = `${td} text-muted`;
const HEAD = [
  { label: 'Time (UTC)' },
  { label: 'Type' },
  { label: 'Amount (USDC)', right: true },
  { label: 'Transaction' },
  { label: 'Seller' },
  { label: 'Channel' },
];
type Row = ReturnType<typeof txRow>;

function Meta({ programId }: { programId: string }) {
  return (
    <span className="flex flex-wrap gap-4">
      <span>Latest, all time · not filtered by range</span>
      <a className={link} href={explorerAddressUrl(programId)}>
        Payments program
        <ArrowUpRight aria-hidden className="size-3" />
      </a>
      <a className={link} href={PAYMENT_PROGRAM_SOURCE_URL}>
        Upstream source
        <ArrowUpRight aria-hidden className="size-3" />
      </a>
    </span>
  );
}

function Seller({
  row,
  lookup,
  query,
}: {
  row: Row;
  lookup: boolean;
  query: ExplorerQuery;
}) {
  if (!lookup)
    return <span className="text-muted">Seller lookup unavailable</span>;
  if (row.shared) return <span className="text-muted">Several channels</span>;
  if (row.seller)
    return (
      <span className="font-mono">
        <Link
          className="text-ink hover:text-brand"
          href={sellerHref(row.seller.nodeId, query)}
          title={`Node ${row.seller.nodeId}`}
        >
          {short(row.seller.nodeId)}
        </Link>
        <span className="block text-xs text-dim">
          <Addr value={row.seller.owner} />
        </span>
      </span>
    );
  return (
    <span className="text-muted" title={row.payTo ?? undefined}>
      Unlisted seller
    </span>
  );
}

export function TxAmount({ row }: { row: Row }) {
  return (
    <td className={row.muted ? `${numberCell} text-muted` : moneyCell}>
      {row.amount}
      {[row.hint, ...row.detail].map((line) =>
        line ? (
          <div
            key={line}
            className="ml-auto max-w-40 font-mono text-xs whitespace-normal text-muted"
          >
            {line}
          </div>
        ) : null,
      )}
    </td>
  );
}

export function TxLine({ row, seller }: { row: Row; seller?: ReactNode }) {
  return (
    <tr className="border-t border-line">
      <td className={timeCell}>{row.time}</td>
      <td className={td} title={row.kind}>
        {row.label}
      </td>
      <TxAmount row={row} />
      <td className={`${td} font-mono`}>
        <a className={link} href={row.href}>
          {row.signature}
          <ArrowUpRight aria-hidden className="size-3" />
        </a>
      </td>
      {seller === undefined ? null : <td className={td}>{seller}</td>}
      <td className={`${td} font-mono`}>
        <Addr value={row.channel} />
      </td>
    </tr>
  );
}

export async function ChannelTxs({ query }: { query: ExplorerQuery }) {
  const { before } = query;
  const [page, discovery] = await Promise.all([
    getChainTxs(before),
    getDiscovery(),
  ]);
  if (page.error)
    return (
      <Unavailable title={TITLE} anchors={[PAGING.anchors.transactions]} />
    );
  const owners = sellerOwners(discovery.sellers);
  const lookup = discovery.error === null;
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.transactions}
        title={TITLE}
        meta={<Meta programId={page.programId} />}
      />
      <p className="-mt-2 mb-3 text-xs text-muted">
        Amounts are per row: the buyer deposit for Deposit and Top-up, newly
        settled for Settle, what the seller side (payee and payout recipients)
        received for Paid out, the only amount in green, and what went back to
        the buyer for Refunded; below a payout, the rest of its split (Gyblos
        fee, payments program, to buyer). Payments program: the payment
        program&apos;s own treasury (rounding remainders, or a share it could
        not deliver), not a Gyblos fee; unclassified: USDC that left the channel
        to no party it names. A payout of several channels shows its batch total
        on its first row; its other rows point to the transaction. Do not add
        them up.
      </p>
      <Table minWidth={DISPLAY.wideTable} head={HEAD}>
        {page.transactions.length ? null : (
          <tr>
            <td className={muted} colSpan={HEAD.length}>
              {before
                ? 'No older transactions.'
                : 'No Gyblos channel transactions.'}
            </td>
          </tr>
        )}
        {page.transactions.map((tx) => {
          const row = txRow(tx, owners, page.treasury);
          return (
            <TxLine
              key={row.key}
              row={row}
              seller={<Seller row={row} lookup={lookup} query={query} />}
            />
          );
        })}
      </Table>
      <Pager
        label={TITLE}
        view={txPager(query, page.transactions.length, page.next)}
      />
    </>
  );
}
