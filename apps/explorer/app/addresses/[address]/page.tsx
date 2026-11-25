import { notFound } from 'next/navigation';

import { TX_AMOUNT_HEAD, TxLine } from '../../../components/channel-txs';
import { PageFrame } from '../../../components/page-frame';
import { pagedRows, Pager } from '../../../components/pager';
import { SellerCell } from '../../../components/seller-cell';
import {
  EmptyRow,
  prefixedColumn,
  SectionTitle,
  Table,
  td,
  Unavailable,
} from '../../../components/ui';
import { getTransactionTable } from '../../../lib/chain-txs';
import { txRow } from '../../../lib/chain-txs-shape';
import { addressHref, explorerAddressUrl } from '../../../lib/config';
import { DISPLAY, PAGING } from '../../../lib/constants';
import { getDiscovery } from '../../../lib/discovery-render';
import { addressLookup } from '../../../lib/entity-search';
import { short } from '../../../lib/format';
import { readQuery, tablePager, type ExplorerQuery } from '../../../lib/paging';
import { githubByNode, namesByNode } from '../../../lib/seller-identity';

export const dynamic = 'force-dynamic';

function RecipientTable({
  page,
  query,
}: {
  page: Awaited<ReturnType<typeof getTransactionTable>>;
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
          prefixedColumn('Type', 'operation'),
          ...TX_AMOUNT_HEAD,
          { label: 'Transaction' },
          { label: 'Channel' },
        ]}
        footer={<Pager label="Recipient transactions" view={page.pager} />}
      >
        {page.transactions.map((tx) => (
          <TxLine
            key={`${tx.signature}:${tx.instructionIndex}`}
            row={txRow(tx, new Map(), page.treasury)}
          />
        ))}
        {!page.transactions.length && (
          <EmptyRow columns={8}>
            No indexed channel operations listing this address as a recipient.
          </EmptyRow>
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
  if (!addressLookup(address)) notFound();
  const query = readQuery(await searchParams, addressHref(address));
  const [discovery, page] = await Promise.all([
    getDiscovery(),
    getTransactionTable(query, address),
  ]);
  const sellers = pagedRows(
    query,
    'sellers',
    discovery.sellers.filter((seller) => seller.owner === address),
    !discovery.error,
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
      {sellers.total > 0 && (
        <>
          <SectionTitle id={PAGING.anchors.sellers} title="Listed sellers" />
          <Table
            minWidth={DISPLAY.narrowTable}
            head={[prefixedColumn('Seller', 'seller')]}
            footer={
              <Pager
                label="Listed sellers"
                view={tablePager(query, 'sellers', sellers)}
              />
            }
          >
            {sellers.rows.map((seller) => (
              <tr key={seller.nodeId} className="border-t border-line">
                <td className={td}>
                  <SellerCell
                    nodeId={seller.nodeId}
                    github={accounts.get(seller.nodeId) ?? null}
                    name={names.get(seller.nodeId)}
                  />
                </td>
              </tr>
            ))}
          </Table>
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
