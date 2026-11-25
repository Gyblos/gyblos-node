import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OperationChip } from '../../components/channel-txs';
import { PageFrame } from '../../components/page-frame';
import { Pager } from '../../components/pager';
import { SellerCell } from '../../components/seller-cell';
import {
  Addr,
  EmptyRow,
  ModelName,
  prefixedColumn,
  SectionTitle,
  Table,
  td,
} from '../../components/ui';
import { getChainTxs } from '../../lib/chain-txs';
import { operationHref } from '../../lib/chain-txs-shape';
import { getCollector } from '../../lib/collector';
import { DISPLAY, RANGE, SEARCH_TERM_LIMIT } from '../../lib/constants';
import { getDiscovery } from '../../lib/discovery-render';
import {
  addressLookup,
  searchPageHref,
  sellerMatches,
} from '../../lib/entity-search';
import { short } from '../../lib/format';
import { modelLab } from '../../lib/model-family';
import { modelRows } from '../../lib/model-table';
import { modelKey, summarizeOffers } from '../../lib/offers';
import { numberedPager, pageOf, parsePage } from '../../lib/paging';
import { namesByNode } from '../../lib/seller-identity';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[] }>;
}) {
  const params = await searchParams;
  const term =
    typeof params.q === 'string'
      ? params.q.trim().slice(0, SEARCH_TERM_LIMIT)
      : '';
  if (!term)
    return (
      <PageFrame title="Search Explorer">
        <p>
          Enter a model, lab, seller, wallet address or recent signature in the
          search field.
        </p>
      </PageFrame>
    );
  const [discovery, collector, chain] = await Promise.all([
    getDiscovery(),
    getCollector(RANGE.defaultDays),
    getChainTxs(null),
  ]);
  const page = pageOf(
    [
      ...catalogResults(term, discovery, collector),
      ...chainResults(
        term,
        discovery.sellers.map((seller) => seller.owner),
        chain,
      ),
    ],
    parsePage(params.page),
  );
  const partial = !!(
    discovery.error ||
    collector.error ||
    chain.error ||
    discovery.network?.truncated
  );
  if (!partial && page.requested !== page.page)
    redirect(searchPageHref(term, page.page));
  return (
    <PageFrame title="Search Explorer" crumb="Search">
      <SectionTitle title="Search results" meta={term} />
      <Table
        minWidth={DISPLAY.narrowTable}
        head={[{ label: 'Type' }, prefixedColumn('Match', 'seller')]}
        footer={
          <Pager
            label="Search results"
            view={numberedPager(page, (target) => searchPageHref(term, target))}
          />
        }
      >
        {page.rows}
        {page.total === 0 && (
          <EmptyRow columns={2}>
            No matches in the model catalog, seller directory or recent
            operations.
          </EmptyRow>
        )}
      </Table>
      {partial && (
        <p className="mt-2 text-xs text-dim">
          Some sources are incomplete. Results may be missing.
        </p>
      )}
    </PageFrame>
  );
}

function chainResults(
  term: string,
  owners: string[],
  chain: Awaited<ReturnType<typeof getChainTxs>>,
) {
  const results = [];
  const addresses = new Set([
    ...owners,
    ...chain.transactions.flatMap((tx) => [tx.channel, ...tx.recipients]),
    chain.treasury,
    chain.programId,
  ]);
  const exact = addressLookup(term);
  if (exact) addresses.add(exact);
  for (const address of addresses)
    if (address.includes(term))
      results.push(
        <tr key={address} className="border-t border-line">
          <td className={td}>
            {address === chain.programId
              ? 'Payments program'
              : address === chain.treasury
                ? 'Program treasury'
                : 'Address'}
          </td>
          <td className={td}>
            <span className="block ps-9">
              <Addr value={address} />
            </span>
          </td>
        </tr>,
      );
  for (const tx of chain.transactions)
    if (tx.signature.includes(term))
      results.push(
        <tr key={operationHref(tx)} className="border-t border-line">
          <td className={td}>
            <OperationChip kind={tx.kind} />
          </td>
          <td className={td}>
            <Link
              href={operationHref(tx)}
              title={tx.signature}
              className="inline-block ps-9 font-mono underline decoration-line underline-offset-2"
            >
              {short(tx.signature)} · instruction {tx.instructionIndex}
            </Link>
          </td>
        </tr>,
      );
  return results;
}

function catalogResults(
  term: string,
  discovery: Awaited<ReturnType<typeof getDiscovery>>,
  collector: Awaited<ReturnType<typeof getCollector>>,
) {
  const lower = term.toLowerCase();
  const models = modelRows(summarizeOffers(discovery).models, collector.models);
  const results = models
    .filter((model) =>
      [
        model.modelId,
        modelLab(model.modelId),
        model.variant,
        model.quantization,
      ].some((value) => value?.toLowerCase().includes(lower)),
    )
    .map((model) => (
      <tr key={modelKey(model)} className="border-t border-line">
        <td className={td}>Model</td>
        <td className={td}>
          <span className="block ps-2">
            <ModelName {...model} />
          </span>
        </td>
      </tr>
    ));
  const nodes = new Map(
    discovery.network?.nodes.map((node) => [node.nodeId, node]),
  );
  const owners = new Map(
    discovery.sellers.map((seller) => [seller.nodeId, seller.owner]),
  );
  const names = namesByNode(discovery.network);
  for (const nodeId of new Set([...nodes.keys(), ...owners.keys()])) {
    const owner = owners.get(nodeId);
    const github = nodes.get(nodeId)?.github ?? null;
    const name = names.get(nodeId);
    if (sellerMatches({ nodeId, name, owner, github }, term))
      results.push(
        <tr key={nodeId} className="border-t border-line">
          <td className={td}>Seller</td>
          <td className={td}>
            <SellerCell nodeId={nodeId} name={name} github={github}>
              {owner && <Addr value={owner} />}
            </SellerCell>
          </td>
        </tr>,
      );
  }
  return results;
}
