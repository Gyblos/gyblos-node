import Link from 'next/link';

import { DISPLAY, PAGING } from '../lib/constants';
import { short, utc } from '../lib/format';
import {
  notOnline,
  type GithubAccount,
  type NetworkStatus,
} from '../lib/network-status';
import { tablePager, type ExplorerQuery } from '../lib/paging';
import { namesByNode, notOnlineMeta, sellerHref } from '../lib/seller-identity';
import { SELLER_STATUS_LABELS } from '../lib/seller-profile';
import { Chip } from './board/chip';
import { pagedRows, Pager } from './pager';
import { SellerCell } from './seller-cell';
import {
  EmptyRow,
  prefixedColumn,
  SectionTitle,
  Table,
  td,
  timeCell,
} from './ui';

export function NotOnline({
  query,
  network,
  accounts,
}: {
  query: ExplorerQuery;
  network: NetworkStatus | null;
  accounts: Map<string, GithubAccount> | null;
}) {
  return (
    <>
      {network ? (
        <>
          <NotOnlineTable query={query} network={network} accounts={accounts} />
          {network.truncated ? (
            <p className="mt-2 text-xs text-dim">
              The index reached one of its limits: these lists and their counts
              may be incomplete.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-xs text-dim">
          The index&apos;s network status could not be read: offline and not
          published sellers are unknown.
        </p>
      )}
    </>
  );
}

function NotOnlineTable({
  query,
  network,
  accounts,
}: {
  query: ExplorerQuery;
  network: NetworkStatus;
  accounts: Map<string, GithubAccount> | null;
}) {
  const nodes = notOnline(network).filter(
    (node) => !accounts || accounts.has(node.nodeId),
  );
  const names = namesByNode(network);
  const page = pagedRows(query, 'offline', nodes, !network.truncated, {
    lastSeen: (node) => node.lastSeenAt,
    firstSeen: (node) => node.firstSeenAt,
  });
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.offline}
        title="Not online"
        meta={notOnlineMeta(network, accounts ? nodes.length : null)}
      />
      <Table
        minWidth={DISPLAY.defaultTable}
        sorting={{ query, table: 'offline' }}
        head={[
          prefixedColumn('Node', 'seller'),
          prefixedColumn('Status', 'chip'),
          { label: 'Last seen', sort: 'lastSeen' },
          { label: 'First seen', sort: 'firstSeen' },
        ]}
        footer={
          <Pager label="Not online" view={tablePager(query, 'offline', page)} />
        }
      >
        {!nodes.length && (
          <EmptyRow columns={4}>
            No offline or unpublished sellers in this list.
          </EmptyRow>
        )}
        {page.rows.map((node) => (
          <tr key={node.nodeId} className="border-t border-line">
            <td className={`${td} font-mono`} title={`Node ${node.nodeId}`}>
              <SellerCell
                nodeId={node.nodeId}
                github={node.github}
                name={names.get(node.nodeId) ?? null}
                href={sellerHref(node.nodeId, query)}
              >
                {node.github ? (
                  <Link
                    href={sellerHref(node.nodeId, query)}
                    title={node.nodeId}
                  >
                    {short(node.nodeId)}
                  </Link>
                ) : null}
              </SellerCell>
            </td>
            <td className={td}>
              <Chip>{SELLER_STATUS_LABELS[node.state]}</Chip>
            </td>
            <td className={timeCell}>{utc(node.lastSeenAt)}</td>
            <td className={timeCell}>{utc(node.firstSeenAt)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
