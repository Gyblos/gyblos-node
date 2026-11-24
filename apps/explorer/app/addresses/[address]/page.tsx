import { notFound } from 'next/navigation';

import { TX_AMOUNT_HEAD, TxLine } from '../../../components/channel-txs';
import { PageFrame } from '../../../components/page-frame';
import { Pager } from '../../../components/pager';
import { SellerCell } from '../../../components/seller-cell';
import { SectionTitle, Table, td, Unavailable } from '../../../components/ui';
import { getChainTxs } from '../../../lib/chain-txs';
import { txRow, type ChainTxPage } from '../../../lib/chain-txs-shape';
import { addressHref, explorerAddressUrl } from '../../../lib/config';
import { DISPLAY, PAGING } from '../../../lib/constants';
import { getDiscovery } from '../../../lib/discovery-render';
import { short } from '../../../lib/format';
import { readQuery, txPager, type ExplorerQuery } from '../../../lib/paging';
import { githubByNode, namesByNode } from '../../../lib/seller-identity';

export const dynamic = 'force-dynamic';

function RecipientTable({
  page,
  query,
}: {
  page: ChainTxPage;
  query: ExplorerQuery;
}) {
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.transactions}
        title="Recipient transactions"
        meta="Newest first · All time"
      />
      <Table
        minWidth={DISPLAY.txTable}
        head={[
          { label: 'Time (UTC)' },
          { label: 'Type' },
          ...TX_AMOUNT_HEAD,
          { label: 'Transaction' },
          { label: 'Channel' },
        ]}
        footer={
          <Pager
            label="Recipient transactions"
            view={txPager(query, page.transactions.length, page.next)}
          />
        }
      >
        {page.transactions.map((tx) => (
          <TxLine
            key={`${tx.signature}:${tx.instructionIndex}`}
            row={txRow(tx, new Map(), page.treasury)}
          />
        ))}
        {!page.transactions.length && (
          <tr>
            <td colSpan={8} className={td}>
              No indexed channel operations listing this address as a recipient.
            </td>
          </tr>
        )}
      </Table>
    </>
  );
}

export default async function AddressPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { address } = await params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) notFound();
  const query = readQuery(await searchParams, addressHref(address));
  const [discovery, page] = await Promise.all([
    getDiscovery(),
    getChainTxs(query.before, address),
  ]);
  const sellers = discovery.sellers.filter(
    (seller) => seller.owner === address,
  );
  const names = namesByNode(discovery.network);
  const accounts = githubByNode(discovery.network);
  return (
    <PageFrame title={`Gyblos address ${short(address)}`} crumb="Address">
      <SectionTitle
        title={
          address === page.programId
            ? 'Payments program'
            : address === page.treasury
              ? 'Program treasury'
              : 'Address'
        }
        meta="Solana devnet"
      />
      <p className="font-mono break-all">{address}</p>
      <a
        href={explorerAddressUrl(address)}
        className="mt-2 inline-block text-sm text-muted underline underline-offset-2"
      >
        View on Solana Explorer ↗
      </a>
      {sellers.length > 0 && (
        <>
          <SectionTitle title="Listed sellers" />
          <ul className="grid gap-3">
            {sellers.map((seller) => (
              <li key={seller.nodeId}>
                <SellerCell
                  nodeId={seller.nodeId}
                  github={accounts.get(seller.nodeId) ?? null}
                  name={names.get(seller.nodeId)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {discovery.error && (
        <p className="mt-4 text-sm text-muted">Seller lookup unavailable.</p>
      )}
      {page.error ? (
        <Unavailable title="Recipient transactions" />
      ) : (
        <RecipientTable page={page} query={query} />
      )}
    </PageFrame>
  );
}
