import Link from 'next/link';
import type { ReactNode } from 'react';

import { HELP_TEXT } from '../lib/config';
import { DISPLAY, PAGES, PAGING } from '../lib/constants';
import type { DiscoverySnapshot, Seller } from '../lib/discovery';
import { getDiscovery } from '../lib/discovery-render';
import { count, percent, pricePerMtok, utc } from '../lib/format';
import type { GithubAccount } from '../lib/network-status';
import { uptimeRatio } from '../lib/offers';
import { queryHref, tablePager, type ExplorerQuery } from '../lib/paging';
import {
  emptySellersMessage,
  githubByNode,
  namesByNode,
  offersCaption,
  orderSellers,
  sellerHref,
  verifiedOnly,
} from '../lib/seller-identity';
import { Chip } from './board/chip';
import { StatusDot } from './board/status-dot';
import { NotOnline } from './not-online';
import { pagedRows, Pager } from './pager';
import { SellerCell } from './seller-cell';
import {
  Addr,
  EmptyRow,
  ModelName,
  moneyCell,
  MoreLink,
  numberCell,
  prefixedColumn,
  SectionTitle,
  Table,
  td,
  timeCell,
  Unavailable,
} from './ui';

const ratioText = (ratio: number | undefined | null) =>
  ratio === undefined || ratio === null ? '—' : percent(ratio);

export async function NetworkSection({
  query,
  preview = false,
}: {
  query: ExplorerQuery;
  preview?: boolean;
}) {
  const { verified } = query;
  const snapshot = await getDiscovery();
  if (snapshot.error)
    return (
      <Unavailable
        title="Network"
        anchors={[PAGING.anchors.sellers, PAGING.anchors.offline]}
      />
    );
  const accounts = githubByNode(snapshot.network);
  const names = namesByNode(snapshot.network);
  const ordered = orderSellers(snapshot.sellers, snapshot.generatedAt);
  const shown = verified ? verifiedOnly(ordered, accounts) : ordered;
  return (
    <>
      {snapshot.datedAt || snapshot.networkDatedAt ? (
        <p className="mt-10 -mb-8 text-xs text-dim">
          {snapshot.datedAt
            ? `Sellers and models as of ${utc(snapshot.datedAt)}. `
            : null}
          {snapshot.networkDatedAt
            ? `Online, offline and not published status as of ${utc(snapshot.networkDatedAt)}.`
            : null}
        </p>
      ) : null}
      <SellersBlock
        query={query}
        sellers={shown}
        accounts={accounts}
        names={names}
        accountsKnown={!!snapshot.network && !snapshot.network.truncated}
      />
      {preview ? (
        <MoreLink href={PAGES.sellers} label="All sellers" />
      ) : (
        <NotOnline
          query={query}
          network={snapshot.network}
          accounts={verified ? accounts : null}
        />
      )}
    </>
  );
}

function SellersBlock({
  query,
  sellers,
  accounts,
  names,
  accountsKnown,
}: {
  query: ExplorerQuery;
  sellers: Seller[];
  accounts: Map<string, GithubAccount>;
  names: Map<string, string>;
  accountsKnown: boolean;
}) {
  return (
    <>
      <SectionTitle
        id={PAGING.anchors.sellers}
        title="Sellers"
        help={HELP_TEXT.verified}
        meta={<VerifiedFilter query={query} />}
      />
      <SellersTable
        query={query}
        sellers={sellers}
        accounts={accounts}
        names={names}
        accountsKnown={accountsKnown}
      />
    </>
  );
}

function VerifiedFilter({ query }: { query: ExplorerQuery }) {
  const filterHref = (verified: boolean) =>
    queryHref(query, { verified, pages: { sellers: 1, offline: 1 } });
  const option = (label: string, href: string, current: boolean) => (
    <Link
      data-query-control=""
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
  prefixedColumn('Seller', 'seller'),
  prefixedColumn('Status', 'online'),
  prefixedColumn('Model', 'model'),
  { label: 'Context', right: true, sort: 'context' },
  { label: 'Input / 1M', right: true, sort: 'input' },
  { label: 'Output / 1M', right: true, sort: 'output' },
  { label: '24 h', right: true, group: 'Uptime', sort: 'uptimeDay' },
  { label: '7 d', right: true, group: 'Uptime', sort: 'uptimeWeek' },
  { label: 'Online since', sort: 'since' },
];
type Offer = ReturnType<typeof sellerOffers>[number];
const SELLER_SORTS = {
  context: ({ model }: Offer) => model.contextTokens,
  input: ({ model }: Offer) => BigInt(model.pricing.inputAtomicPerMtok),
  output: ({ model }: Offer) => BigInt(model.pricing.outputAtomicPerMtok),
  uptimeDay: ({ seller }: Offer) => uptimeRatio(seller, DISPLAY.dayWindow),
  uptimeWeek: ({ seller }: Offer) => uptimeRatio(seller, DISPLAY.weekWindow),
  since: ({ seller }: Offer) => seller.uptime?.firstSeenAt,
};

const sellerOffers = (sellers: Seller[]) =>
  sellers.flatMap((seller) =>
    seller.models.map((model) => ({ seller, model })),
  );

function OfferRow({
  days,
  closed,
  seller,
  model,
  cell,
}: {
  seller: Seller;
  model: Seller['models'][number];
  cell: ReactNode;
  days: ExplorerQuery['days'];
  closed?: boolean;
}) {
  return (
    <tr className="border-t border-line">
      <td className={`${td} font-mono`} title={`Node ${seller.nodeId}`}>
        {cell}
      </td>
      <td className={td}>
        <Chip tone="online">
          <StatusDot />
          Online
        </Chip>
      </td>
      <td className={td}>
        <ModelName
          days={days}
          closed={closed}
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
        {ratioText(uptimeRatio(seller, DISPLAY.dayWindow))}
      </td>
      <td className={numberCell}>
        {ratioText(uptimeRatio(seller, DISPLAY.weekWindow))}
      </td>
      <td className={timeCell}>{utc(seller.uptime?.firstSeenAt ?? null)}</td>
    </tr>
  );
}

function SellersTable({
  query,
  sellers,
  accounts,
  names,
  accountsKnown,
}: {
  query: ExplorerQuery;
  sellers: Seller[];
  accounts: Map<string, GithubAccount>;
  names: Map<string, string>;
  accountsKnown: boolean;
}) {
  const empty = emptySellersMessage(sellers, query.verified, accountsKnown);
  const offers = sellerOffers(sellers);
  const page = pagedRows(
    query,
    'sellers',
    offers,
    !query.verified || accountsKnown,
    SELLER_SORTS,
  );
  return (
    <>
      <Table
        minWidth={DISPLAY.wideTable}
        head={SELLERS_HEAD}
        sorting={{ query, table: 'sellers' }}
        footer={
          <Pager label="Sellers" view={tablePager(query, 'sellers', page)} />
        }
      >
        {empty ? (
          <EmptyRow columns={SELLERS_HEAD.length}>{empty}</EmptyRow>
        ) : null}
        {page.rows.map(({ seller, model }) => (
          <OfferRow
            days={query.days}
            closed={query.closed}
            key={`${seller.nodeId}:${model.modelId}:${model.variant}:${model.quantization}`}
            seller={seller}
            model={model}
            cell={
              <SellerCell
                nodeId={seller.nodeId}
                github={accounts.get(seller.nodeId) ?? null}
                name={names.get(seller.nodeId) ?? null}
                href={sellerHref(seller.nodeId, query)}
              >
                <Addr value={seller.owner} />
              </SellerCell>
            }
          />
        ))}
      </Table>
      {offers.length ? (
        <p className="mt-2 text-xs text-dim">
          {offersCaption(offers.length, sellers.length)}
        </p>
      ) : null}
    </>
  );
}
