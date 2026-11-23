import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { getChainTxs } from '../lib/chain-txs';
import { sellerOwners, txPageHref, txRow } from '../lib/chain-txs-shape';
import { explorerAddressUrl, PAYMENT_PROGRAM_SOURCE_URL } from '../lib/config';
import { DISPLAY } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import type { RangeDays } from '../lib/range';
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

function TxLine({ row, lookup }: { row: Row; lookup: boolean }) {
  return (
    <tr className="border-t border-line">
      <td className={timeCell}>{row.time}</td>
      <td className={td} title={row.kind}>
        {row.label}
      </td>
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

function Pager({
  days,
  verified,
  newest,
  older,
}: {
  days: RangeDays;
  verified: boolean;
  newest: boolean;
  older: string | null;
}) {
  if (!newest && !older) return null;
  return (
    <nav className="my-3 flex justify-end gap-4 font-mono text-xs text-muted">
      {newest ? (
        <Link
          className={link}
          href={txPageHref(days, null, verified)}
          scroll={false}
        >
          Newest
        </Link>
      ) : null}
      {older ? (
        <Link
          className={link}
          href={txPageHref(days, older, verified)}
          scroll={false}
        >
          Older
        </Link>
      ) : null}
    </nav>
  );
}

export async function ChannelTxs({
  days,
  before,
  verified,
}: {
  days: RangeDays;
  before: string | null;
  verified: boolean;
}) {
  const [page, discovery] = await Promise.all([
    getChainTxs(before),
    getDiscovery(),
  ]);
  if (page.error) return <Unavailable title={TITLE} />;
  const owners = sellerOwners(discovery.sellers);
  const lookup = discovery.error === null;
  return (
    <>
      <SectionTitle title={TITLE} meta={<Meta programId={page.programId} />} />
      <p className="-mt-2 mb-3 text-xs text-muted">
        Amounts are per row: deposit in for Deposit and Top-up, newly settled
        for Settle, what the seller got for Paid out and the refund for
        Refunded; below a payout, the rest of its split (Gyblos fee, payments
        program, to buyer). Payments program: the payment program&apos;s own
        treasury (rounding remainder), not a Gyblos fee. Do not add them up.
      </p>
      <Pager
        days={days}
        verified={verified}
        newest={before !== null}
        older={null}
      />
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
        days={days}
        verified={verified}
        newest={before !== null}
        older={page.next}
      />
    </>
  );
}
