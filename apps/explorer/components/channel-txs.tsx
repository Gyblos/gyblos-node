import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { getChainTxs } from '../lib/chain-txs';
import { sellerOwners, txPageHref, txRow } from '../lib/chain-txs-shape';
import { explorerAddressUrl, PAYMENT_PROGRAM_SOURCE_URL } from '../lib/config';
import { DISPLAY } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { short } from '../lib/format';
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
const HEAD = [
  { label: 'Time (UTC)' },
  { label: 'Type' },
  { label: 'Channel' },
  { label: 'Seller' },
  { label: 'Amount (USDC)', right: true },
  { label: 'Transaction' },
];

function Links({ programId }: { programId: string }) {
  return (
    <span className="flex gap-4">
      <a className={link} href={explorerAddressUrl(programId)}>
        Payments program
        <ArrowUpRight aria-hidden className="size-3" />
      </a>
      <a className={link} href={PAYMENT_PROGRAM_SOURCE_URL}>
        Source
        <ArrowUpRight aria-hidden className="size-3" />
      </a>
    </span>
  );
}

function Seller({ row }: { row: ReturnType<typeof txRow> }) {
  if (row.seller)
    return (
      <span className="font-mono" title={`Node ${row.seller}`}>
        {short(row.seller)}
      </span>
    );
  return (
    <span className="text-muted" title={row.payee ?? undefined}>
      Unknown payee
    </span>
  );
}

export async function ChannelTxs({
  days,
  before,
}: {
  days: RangeDays;
  before: string | null;
}) {
  const [page, discovery] = await Promise.all([
    getChainTxs(before),
    getDiscovery(),
  ]);
  if (page.error) return <Unavailable title={TITLE} />;
  const owners = sellerOwners(discovery.sellers);
  return (
    <>
      <SectionTitle title={TITLE} meta={<Links programId={page.programId} />} />
      <Table minWidth={DISPLAY.wideTable} head={HEAD}>
        {page.transactions.length ? null : (
          <tr>
            <td className={`${td} text-muted`} colSpan={HEAD.length}>
              No Gyblos channel transactions.
            </td>
          </tr>
        )}
        {page.transactions.map((tx) => {
          const row = txRow(tx, owners);
          return (
            <tr key={row.key} className="border-t border-line">
              <td className={timeCell}>{row.time}</td>
              <td className={`${td} font-mono`}>{row.kind}</td>
              <td className={`${td} font-mono`}>
                <Addr value={row.channel} />
              </td>
              <td className={td}>
                <Seller row={row} />
              </td>
              <td
                className={
                  tx.amount === null ? `${numberCell} text-muted` : moneyCell
                }
              >
                {row.amount}
              </td>
              <td className={`${td} font-mono`}>
                <a className={link} href={row.href}>
                  {row.signature}
                  <ArrowUpRight aria-hidden className="size-3" />
                </a>
              </td>
            </tr>
          );
        })}
      </Table>
      <nav className="mt-3 flex justify-end gap-4 font-mono text-xs text-muted">
        {before ? (
          <Link className={link} href={txPageHref(days, null)} scroll={false}>
            Newest
          </Link>
        ) : null}
        {page.next ? (
          <Link
            className={link}
            href={txPageHref(days, page.next)}
            scroll={false}
          >
            Older
          </Link>
        ) : null}
      </nav>
    </>
  );
}
