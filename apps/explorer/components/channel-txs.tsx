import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Chip, type ChipColor } from '../boardui/components/base/badges/chip';
import { getChainTxs } from '../lib/chain-txs';
import { sellerOwners, txRow, type ChainTxKind } from '../lib/chain-txs-shape';
import {
  addressHref,
  HELP_TEXT,
  PAYMENT_PROGRAM_SOURCE_URL,
} from '../lib/config';
import { DISPLAY, PAGES, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import type { GithubAccount } from '../lib/network-status';
import { txPager, type ExplorerQuery } from '../lib/paging';
import { githubByNode, namesByNode, sellerHref } from '../lib/seller-identity';
import { Pager } from './pager';
import { SellerCell } from './seller-cell';
import {
  Addr,
  moneyCell,
  MoreLink,
  numberCell,
  SectionTitle,
  Table,
  td,
  timeCell,
  Unavailable,
} from './ui';

const TITLE = 'Channel transactions';
const link =
  'inline-flex items-center gap-1 hover:text-ink hover:underline underline-offset-2';
const muted = `${td} text-muted`;
export const TX_AMOUNT_HEAD = [
  { label: 'Amount', right: true, group: 'USDC' },
  { label: 'Gyblos fee', right: true, group: 'USDC' },
  { label: 'Program', right: true, group: 'USDC' },
  { label: 'To buyer', right: true, group: 'USDC' },
];

const HEAD = [
  { label: 'Time (UTC)' },
  { label: 'Type' },
  ...TX_AMOUNT_HEAD,
  { label: 'Transaction' },
  { label: 'Seller' },
  { label: 'Channel' },
];
type Row = ReturnType<typeof txRow>;

function Meta({ programId }: { programId: string }) {
  return (
    <span className="flex flex-wrap gap-4">
      <span>Newest first, all time, not filtered by range</span>
      <Link className={link} href={addressHref(programId)}>
        Payments program
      </Link>
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
  accounts,
  names,
  query,
}: {
  row: Row;
  lookup: boolean;
  accounts: ReadonlyMap<string, GithubAccount>;
  names: ReadonlyMap<string, string>;
  query: ExplorerQuery;
}) {
  if (!lookup)
    return <span className="text-muted">Seller lookup unavailable</span>;
  if (row.shared) return <span className="text-muted">Several channels</span>;
  if (row.seller)
    return (
      <SellerCell
        nodeId={row.seller.nodeId}
        github={accounts.get(row.seller.nodeId) ?? null}
        name={names.get(row.seller.nodeId)}
        href={sellerHref(row.seller.nodeId, query)}
      >
        <Addr value={row.seller.owner} />
      </SellerCell>
    );
  return (
    <span className="text-muted" title={row.payTo ?? undefined}>
      {row.payTo ? (
        <>
          Recipient <Addr value={row.payTo} />
        </>
      ) : (
        '—'
      )}
    </span>
  );
}

const KIND_COLORS: Record<ChainTxKind, ChipColor> = {
  open: 'blue',
  top_up: 'blue',
  settle: 'soft',
  settle_and_seal: 'soft',
  request_close: 'soft',
  seal: 'soft',
  distribute: 'lime',
  reclaim: 'neutral',
};

export function OperationChip({ row }: { row: Row }) {
  return (
    <Chip variant="caption" color={KIND_COLORS[row.kind]}>
      {row.label}
    </Chip>
  );
}

export function TxAmount({ row }: { row: Row }) {
  const part = (value: string | null) => (
    <td className={`${numberCell} text-muted`}>{value ?? '—'}</td>
  );
  return (
    <>
      <td className={row.muted ? `${numberCell} text-muted` : moneyCell}>
        {row.amount}
        {row.detail.map((line) => (
          <div
            key={line}
            className="ml-auto max-w-48 font-sans text-xs whitespace-normal text-dim"
          >
            {line}
          </div>
        ))}
      </td>
      {part(row.parts.gyblosFees)}
      {part(row.parts.programTreasury)}
      {part(row.parts.refunded)}
    </>
  );
}

export function TxLine({ row, seller }: { row: Row; seller?: ReactNode }) {
  return (
    <tr className="border-t border-line">
      <td className={timeCell}>{row.time}</td>
      <td className={td} title={row.kind}>
        <OperationChip row={row} />
      </td>
      <TxAmount row={row} />
      <td className={`${td} font-mono`}>
        <Link className={link} href={row.href}>
          {row.signature}
        </Link>
      </td>
      {seller === undefined ? null : <td className={td}>{seller}</td>}
      <td className={`${td} font-mono`}>
        <Addr value={row.channel} />
      </td>
    </tr>
  );
}

export async function ChannelTxs({
  query,
  preview = false,
}: {
  query: ExplorerQuery;
  preview?: boolean;
}) {
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
  const accounts = githubByNode(discovery.network);
  const names = namesByNode(discovery.network);
  const lookup = discovery.error === null;
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.transactions}
        title={TITLE}
        help={HELP_TEXT.channelTransactions}
        meta={<Meta programId={page.programId} />}
      />
      <Table
        minWidth={DISPLAY.txTable}
        head={HEAD}
        footer={
          <Pager
            label={TITLE}
            view={txPager(query, page.transactions.length, page.next)}
          />
        }
      >
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
              seller={
                <Seller
                  accounts={accounts}
                  names={names}
                  row={row}
                  lookup={lookup}
                  query={query}
                />
              }
            />
          );
        })}
      </Table>
      {preview ? (
        <MoreLink href={PAGES.transactions} label="All transactions" />
      ) : null}
    </>
  );
}
