import { ArrowUpRight } from 'lucide-react';

import { getChainTxs } from '../lib/chain-txs';
import { txRow } from '../lib/chain-txs-shape';
import { DISPLAY, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { txPager, type ExplorerQuery } from '../lib/paging';
import { sellerProfile } from '../lib/seller-profile';
import { TxAmount } from './channel-txs';
import { Pager } from './pager';
import { Addr, SectionTitle, Table, td, timeCell, Unavailable } from './ui';

const TITLE = 'Channel transactions';
const link = 'inline-flex items-center gap-1 hover:text-brand';
const NO_OWNERS = new Map<string, never>();
const HEAD = [
  { label: 'Time (UTC)' },
  { label: 'Type' },
  { label: 'Amount (USDC)', right: true },
  { label: 'Transaction' },
  { label: 'Channel' },
];

function Note({ children }: { children: string }) {
  return (
    <>
      <SectionTitle id={PAGING.anchors.transactions} title={TITLE} />
      <div className="rounded-2xl border border-line bg-panel p-5 text-sm text-muted">
        {children}
      </div>
    </>
  );
}

export async function SellerTxs({
  nodeId,
  query,
}: {
  nodeId: string;
  query: ExplorerQuery;
}) {
  const snapshot = await getDiscovery();
  if (snapshot.error) return <Unavailable title={TITLE} />;
  const profile = sellerProfile(nodeId, snapshot);
  if (!profile.owner)
    return (
      <Note>
        Channel transactions are found by the seller&apos;s owner address, which
        the discovery index publishes only while the seller is online.
      </Note>
    );
  const page = await getChainTxs(query.before, profile.owner);
  if (page.error) return <Unavailable title={TITLE} />;
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.transactions}
        title={TITLE}
        meta="Latest, all time · not filtered by range"
      />
      <p className="-mt-2 mb-3 text-xs text-muted">
        Channels whose payout recipient is this seller&apos;s self-declared
        owner address. Paid out is what that address got; below it, the rest of
        the split. A row marked &quot;total of N channels&quot; is a transaction
        that paid several channels, possibly to other sellers. Do not add the
        amounts up.
        {profile.ownerShared
          ? ' Another listed seller publishes the same owner address, so these channels may belong to either of them.'
          : null}
      </p>
      <Table minWidth={DISPLAY.defaultTable} head={HEAD}>
        {page.transactions.length ? null : (
          <tr>
            <td className={`${td} text-muted`} colSpan={HEAD.length}>
              {query.before
                ? 'No older transactions.'
                : 'No Gyblos channel transactions pay this owner address.'}
            </td>
          </tr>
        )}
        {page.transactions.map((tx) => {
          const row = txRow(tx, NO_OWNERS, page.treasury);
          return (
            <tr key={row.key} className="border-t border-line">
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
              <td className={`${td} font-mono`}>
                <Addr value={row.channel} />
              </td>
            </tr>
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
