import { DISPLAY, PAGING } from '../lib/constants';
import { short, utc } from '../lib/format';
import {
  notOnline,
  type GithubAccount,
  type NetworkStatus,
} from '../lib/network-status';
import { tablePager, type ExplorerQuery } from '../lib/paging';
import { notOnlineMeta, sellerHref } from '../lib/seller-identity';
import { SELLER_STATUS_LABELS } from '../lib/seller-profile';
import { Chip } from './board/chip';
import { pagedRows, Pager } from './pager';
import { SellerCell } from './seller-cell';
import { SectionTitle, Table, td, timeCell } from './ui';

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
  const page = pagedRows(query, 'offline', nodes, !network.truncated);
  if (!nodes.length) return null;
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.offline}
        title="Not online"
        meta={notOnlineMeta(network, accounts ? nodes.length : null)}
      />
      <Table
        minWidth={DISPLAY.defaultTable}
        head={[
          { label: 'Node' },
          { label: 'Status' },
          { label: 'Last seen' },
          { label: 'First seen' },
        ]}
      >
        {page.rows.map((node) => (
          <tr key={node.nodeId} className="border-t border-line">
            <td className={`${td} font-mono`} title={`Node ${node.nodeId}`}>
              <SellerCell
                nodeId={node.nodeId}
                github={node.github}
                name={node.name}
                href={sellerHref(node.nodeId, query)}
              >
                {node.github ? short(node.nodeId) : null}
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
      <Pager label="Not online" view={tablePager(query, 'offline', page)} />
    </>
  );
}
