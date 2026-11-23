import { getChainTxs } from '../lib/chain-txs';
import { txRow } from '../lib/chain-txs-shape';
import { DISPLAY, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { txPager, type ExplorerQuery } from '../lib/paging';
import { sellerProfile } from '../lib/seller-profile';
import { TxLine } from './channel-txs';
import { Pager } from './pager';
import { SectionTitle, Table, td, Unavailable } from './ui';

const TITLE = 'Channel transactions';
const ANCHORS = [PAGING.anchors.transactions];
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
  if (snapshot.error) return <Unavailable title={TITLE} anchors={ANCHORS} />;
  const profile = sellerProfile(nodeId, snapshot);
  if (!profile.owner)
    return (
      <Note>
        Channel transactions are found by the seller&apos;s owner address, which
        the discovery index publishes only while the seller is online.
      </Note>
    );
  const page = await getChainTxs(query.before, profile.owner);
  if (page.error) return <Unavailable title={TITLE} anchors={ANCHORS} />;
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.transactions}
        title={TITLE}
        meta="Latest, all time · not filtered by range"
      />
      <p className="-mt-2 mb-3 text-xs text-muted">
        Channels whose payout recipient is this seller&apos;s self-declared
        owner address. Paid out, the only amount in green, is what the seller
        side (payee and payout recipients) received; below it, the rest of the
        split. A batch total covers every channel its transaction paid, possibly
        other sellers&apos; too, and a row marked as part of such a payout has
        its amount on that transaction&apos;s first row. Do not add the amounts
        up.
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
          return <TxLine key={row.key} row={row} />;
        })}
      </Table>
      <Pager
        label={TITLE}
        view={txPager(query, page.transactions.length, page.next)}
      />
    </>
  );
}
