import { getTransactionTable } from '../lib/chain-txs';
import { txRow } from '../lib/chain-txs-shape';
import { HELP_TEXT } from '../lib/config';
import { DISPLAY, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { type ExplorerQuery } from '../lib/paging';
import { sellerProfile } from '../lib/seller-profile';
import { TX_AMOUNT_HEAD, TxLine } from './channel-txs';
import { Pager } from './pager';
import {
  EmptyRow,
  prefixedColumn,
  SectionTitle,
  Table,
  Unavailable,
} from './ui';

const TITLE = 'Channel transactions';
const ANCHORS = [PAGING.anchors.transactions];
const NO_OWNERS = new Map<string, never>();
const HEAD = [
  { label: 'Time (UTC)' },
  prefixedColumn('Type', 'operation'),
  ...TX_AMOUNT_HEAD,
  { label: 'Transaction' },
  { label: 'Channel' },
];

function Note({ children }: { children: string }) {
  return (
    <>
      <SectionTitle id={PAGING.anchors.transactions} title={TITLE} />
      <div className="rounded-xl border border-line bg-panel p-5 text-sm text-muted">
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
  const page = await getTransactionTable(query, profile.owner);
  if (page.error) return <Unavailable title={TITLE} anchors={ANCHORS} />;
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.transactions}
        title={TITLE}
        help={HELP_TEXT.sellerTransactions}
        meta="Newest first, all time, not filtered by range"
      />
      {profile.ownerShared ? (
        <p className="-mt-2 mb-3 text-xs text-muted">
          Another listed seller publishes the same owner address, so these
          channels may belong to either of them.
        </p>
      ) : null}
      <Table
        minWidth={DISPLAY.txTable}
        head={HEAD}
        footer={<Pager label={TITLE} view={page.pager} />}
      >
        {page.transactions.length ? null : (
          <EmptyRow columns={HEAD.length}>
            {query.before
              ? 'No older transactions.'
              : 'No Gyblos channel transactions pay this owner address.'}
          </EmptyRow>
        )}
        {page.transactions.map((tx) => {
          const row = txRow(tx, NO_OWNERS, page.treasury);
          return <TxLine key={row.key} row={row} />;
        })}
      </Table>
    </>
  );
}
