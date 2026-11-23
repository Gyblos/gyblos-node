// Owns the Network section: sellers online and offline, the models offered and their cheapest prices,
// each online seller's offers and uptime, and the registered sellers not online now, from the discovery
// index. The per-model table lives in the Models section.
import { Activity, BadgeCheck, Boxes, Server, Tag } from 'lucide-react';
import Link from 'next/link';

import { HOW_TO_VERIFY_URL } from '../lib/config';
import { DISPLAY } from '../lib/constants';
import type { DiscoverySnapshot, Seller } from '../lib/discovery';
import { getDiscovery } from '../lib/discovery-render';
import { count, percent, pricePerMtok, short, usdc, utc } from '../lib/format';
import {
  notOnline,
  type GithubAccount,
  type NetworkNode,
  type NetworkStatus,
} from '../lib/network-status';
import { summarizeOffers, uptimeRatio } from '../lib/offers';
import {
  queryHref,
  tablePage,
  tablePager,
  type ExplorerQuery,
} from '../lib/paging';
import {
  emptySellersMessage,
  githubByNode,
  notOnlineMeta,
  orderSellers,
  verifiedOnly,
} from '../lib/seller-identity';
import { Flow } from './board/animated-number';
import { Chip } from './board/chip';
import { StatCard } from './board/stat-card';
import { StatusDot } from './board/status-dot';
import { Pager } from './pager';
import { SellerCell } from './seller-cell';
import {
  Addr,
  ModelName,
  moneyCell,
  numberCell,
  SectionTitle,
  Table,
  td,
  timeCell,
  Unavailable,
} from './ui';

const ratioText = (ratio: number | undefined | null) =>
  ratio === undefined || ratio === null ? '—' : percent(ratio);
const priceText = (value: bigint | null) =>
  value === null ? '—' : usdc(value);

export async function NetworkSection({ query }: { query: ExplorerQuery }) {
  const { verified } = query;
  const snapshot = await getDiscovery();
  if (snapshot.error) return <Unavailable title="Network" />;
  const summary = summarizeOffers(snapshot);
  const accounts = githubByNode(snapshot.network);
  const ordered = orderSellers(snapshot.sellers, snapshot.generatedAt);
  const shown = verified ? verifiedOnly(ordered, accounts) : ordered;
  return (
    <>
      <SectionTitle title="Network" meta={utc(snapshot.generatedAt)} />
      {snapshot.datedAt || snapshot.networkDatedAt ? (
        <p className="-mt-2 mb-3 text-xs text-dim">
          {snapshot.datedAt
            ? `Sellers and models as of ${utc(snapshot.datedAt)}. `
            : null}
          {snapshot.networkDatedAt
            ? `Online, offline and not published status as of ${utc(snapshot.networkDatedAt)}.`
            : null}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SellersOnline snapshot={snapshot} />
        <StatCard
          icon={Boxes}
          label="Models"
          value={<Flow value={summary.models.size} kind="count" />}
          caption={`${count(summary.freeModels)} with a free seller`}
        />
        <StatCard
          icon={Tag}
          label="Lowest output price / 1M"
          value={priceText(summary.minOutput)}
          caption={
            summary.minInput === null
              ? 'No paid offers now'
              : `Input from ${usdc(summary.minInput)}`
          }
          money={summary.minOutput !== null}
        />
        <StatCard
          icon={Activity}
          label="Uptime 24 h"
          value={ratioText(summary.averageDayUptime)}
          caption={
            summary.averageDayUptime === null
              ? undefined
              : `Average over ${count(summary.sellersWithDayUptime)} of ${count(snapshot.sellers.length)} listed sellers`
          }
        />
      </div>

      <SellersBlock
        query={query}
        sellers={shown}
        accounts={accounts}
        accountsKnown={!!snapshot.network && !snapshot.network.truncated}
      />
      <NotOnline
        query={query}
        network={snapshot.network}
        accounts={verified ? accounts : null}
      />
    </>
  );
}

// Online sellers out of every registered or recently seen one; without the index's network status,
// only the online count is known.
function SellersOnline({ snapshot }: { snapshot: DiscoverySnapshot }) {
  const counts = snapshot.network?.counts;
  return (
    <StatCard
      icon={Server}
      label="Sellers online"
      value={
        <Flow value={counts?.online ?? snapshot.sellers.length} kind="count" />
      }
      caption={
        counts
          ? [
              `${count(counts.online)} of ${count(counts.total)} registered`,
              `${count(counts.offline)} offline`,
              ...(counts.unpublished
                ? [`${count(counts.unpublished)} not published`]
                : []),
            ].join(' · ')
          : undefined
      }
    />
  );
}

function SellersBlock({
  query,
  sellers,
  accounts,
  accountsKnown,
}: {
  query: ExplorerQuery;
  sellers: Seller[];
  accounts: Map<string, GithubAccount>;
  accountsKnown: boolean;
}) {
  return (
    <>
      <SectionTitle title="Sellers" meta={<VerifiedFilter query={query} />} />
      <SellersTable
        query={query}
        sellers={sellers}
        accounts={accounts}
        accountsKnown={accountsKnown}
      />
      <p className="mt-2 flex items-center gap-1 text-xs text-dim">
        <BadgeCheck
          aria-hidden="true"
          className="size-3.5 shrink-0 text-signal"
        />
        <span>
          The discovery index checked that the named GitHub account published
          the seller&apos;s NodeId. It links the seller to that account; it does
          not identify a person and says nothing about quality.{' '}
          <a className="text-muted hover:text-brand" href={HOW_TO_VERIFY_URL}>
            How to verify
          </a>
        </span>
      </p>
    </>
  );
}

function VerifiedFilter({ query }: { query: ExplorerQuery }) {
  const filterHref = (verified: boolean) =>
    queryHref(query, { verified, pages: { sellers: 1, offline: 1 } });
  const option = (label: string, href: string, current: boolean) => (
    <Link
      href={href}
      scroll={false}
      aria-current={current ? 'true' : undefined}
      className={
        current
          ? 'rounded-md bg-raised px-1.5 py-0.5 text-ink'
          : 'rounded-md px-1.5 py-0.5 hover:text-ink'
      }
    >
      {label}
    </Link>
  );
  return (
    <span className="flex items-center gap-1">
      {option('All', filterHref(false), !query.verified)}
      {option('Verified only', filterHref(true), query.verified)}
    </span>
  );
}

const SELLERS_HEAD = [
  { label: 'Seller' },
  { label: 'Status' },
  { label: 'Model' },
  { label: 'Context', right: true },
  { label: 'Input / 1M', right: true },
  { label: 'Output / 1M', right: true },
  { label: 'Uptime 24 h · 7 d', right: true },
  { label: 'Online since' },
];

function SellersTable({
  query,
  sellers,
  accounts,
  accountsKnown,
}: {
  query: ExplorerQuery;
  sellers: Seller[];
  accounts: Map<string, GithubAccount>;
  accountsKnown: boolean;
}) {
  const empty = emptySellersMessage(sellers, query.verified, accountsKnown);
  const page = tablePage(
    query,
    'sellers',
    sellers.flatMap((seller) =>
      seller.models.map((model) => ({ seller, model })),
    ),
  );
  return (
    <>
      <Table minWidth={DISPLAY.wideTable} head={SELLERS_HEAD}>
        {empty ? (
          <tr>
            <td className={`${td} text-muted`} colSpan={SELLERS_HEAD.length}>
              {empty}
            </td>
          </tr>
        ) : null}
        {page.rows.map(({ seller, model }) => (
          <tr
            key={`${seller.nodeId}:${model.modelId}:${model.variant}:${model.quantization}`}
            className="border-t border-line"
          >
            <td className={`${td} font-mono`} title={`Node ${seller.nodeId}`}>
              <SellerCell
                nodeId={seller.nodeId}
                github={accounts.get(seller.nodeId) ?? null}
              >
                <Addr value={seller.owner} />
              </SellerCell>
            </td>
            <td className={td}>
              <Chip tone="brand">
                <StatusDot />
                Online
              </Chip>
            </td>
            <td className={td}>
              <ModelName
                modelId={model.modelId}
                variant={model.variant}
                quantization={model.quantization}
              />
            </td>
            <td className={numberCell}>{count(model.contextTokens)}</td>
            <td className={moneyCell}>
              {pricePerMtok(model.pricing.inputAtomicPerMtok)}
            </td>
            <td className={moneyCell}>
              {pricePerMtok(model.pricing.outputAtomicPerMtok)}
            </td>
            <td className={numberCell}>
              {ratioText(uptimeRatio(seller, DISPLAY.dayWindow))} ·{' '}
              {ratioText(uptimeRatio(seller, DISPLAY.weekWindow))}
            </td>
            <td className={timeCell}>
              {utc(seller.uptime?.firstSeenAt ?? null)}
            </td>
          </tr>
        ))}
      </Table>
      <Pager label="Sellers" view={tablePager(query, 'sellers', page)} />
    </>
  );
}

function NotOnline({
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

const STATE_LABELS: Record<Exclude<NetworkNode['state'], 'online'>, string> = {
  offline: 'Offline',
  unpublished: 'Not published',
};

// Registered or recently seen sellers without a live presence now. Offline ones were seen before;
// unpublished ones were never seen or withdrew their catalog.
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
  if (!nodes.length) return null;
  const page = tablePage(query, 'offline', nodes);
  return (
    <>
      <SectionTitle
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
              <SellerCell nodeId={node.nodeId} github={node.github}>
                {node.github ? short(node.nodeId) : null}
              </SellerCell>
            </td>
            <td className={td}>
              <Chip>
                {node.state === 'online' ? 'Online' : STATE_LABELS[node.state]}
              </Chip>
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
