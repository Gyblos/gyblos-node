import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { getChainTxs } from '../lib/chain-txs';
import { sellerOwners, txRow } from '../lib/chain-txs-shape';
import { explorerAddressUrl, PAYMENT_PROGRAM_SOURCE_URL } from '../lib/config';
import { DISPLAY, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { queryHref, txPager, type ExplorerQuery } from '../lib/paging';
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

function Seller({ row, lookup }: { row: Row; lookup: boolean }) {
  if (!lookup)
    return <span className="text-muted">Seller lookup unavailable</span>;
  if (row.shared) return <span className="text-muted">Several channels</span>;
  if (row.seller)
    return (
      <span className="font-mono" title={`Node ${row.seller.nodeId}`}>
        <Addr value={row.seller.owner} />
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
      {row.detail.map((line) => (
        <div
          key={line}
          className="ml-auto max-w-40 font-mono text-xs whitespace-normal text-muted"
        >
          {line}
        </div>
      ))}
    </td>
  );
}

function TxLine({ row, lookup }: { row: Row; lookup: boolean }) {
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
      <td className={td}>
        <Seller row={row} lookup={lookup} />
      </td>
      <td className={`${td} font-mono`}>
        <Addr value={row.channel} />
      </td>
    </tr>
  );
}

function NewestLink({ query }: { query: ExplorerQuery }) {
  if (!query.before) return null;
  return (
    <p className="my-3 text-right font-mono text-xs text-muted">
      <Link
        className={`${link} py-1 underline-offset-2 hover:underline`}
        href={`${queryHref(query, { before: null })}#${PAGING.anchors.transactions}`}
      >
        Back to newest
      </Link>
    </p>
  );
}

export async function ChannelTxs({ query }: { query: ExplorerQuery }) {
  const { before } = query;
  const [page, discovery] = await Promise.all([
    getChainTxs(before),
    getDiscovery(),
  ]);
  if (page.error) return <Unavailable title={TITLE} />;
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
        Amounts are per row: deposit in for Deposit and Top-up, newly settled
        for Settle, what the seller got for Paid out and the refund for
        Refunded; below a payout, the rest of its split (Gyblos fee, payments
        program, to buyer). Payments program: the payment program&apos;s own
        treasury (rounding remainders, or a share it could not deliver), not a
        Gyblos fee; unclassified: USDC that left the channel to no party it
        names. Do not add them up.
      </p>
      <NewestLink query={query} />
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
          return <TxLine key={row.key} row={row} lookup={lookup} />;
        })}
      </Table>
      <Pager
        label={TITLE}
        view={txPager(query, page.transactions.length, page.next)}
      />
    </>
  );
}
