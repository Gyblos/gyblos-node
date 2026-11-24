import Link from 'next/link';

import { Identicon } from '../../components/identicon';
import { ModelLogo } from '../../components/model-logo';
import { PageFrame } from '../../components/page-frame';
import { SectionTitle } from '../../components/ui';
import { getChainTxs } from '../../lib/chain-txs';
import { CHAIN_TX_LABELS, operationHref } from '../../lib/chain-txs-shape';
import { getCollector } from '../../lib/collector';
import { addressHref } from '../../lib/config';
import { RANGE, SEARCH_TERM_LIMIT } from '../../lib/constants';
import { getDiscovery } from '../../lib/discovery-render';
import { short } from '../../lib/format';
import { modelLab } from '../../lib/model-family';
import { modelRows } from '../../lib/model-table';
import { modelHref, summarizeOffers } from '../../lib/offers';
import { sellerHref } from '../../lib/seller-identity';

const rowClass =
  'flex items-center gap-3 rounded-lg px-3 py-3 hover:bg-raised focus-visible:outline-signal';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const raw = (await searchParams).q;
  const term =
    typeof raw === 'string' ? raw.trim().slice(0, SEARCH_TERM_LIMIT) : '';
  if (!term)
    return (
      <PageFrame title="Search Explorer">
        <SectionTitle title="Search Explorer" />
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
  const results = catalogResults(term, discovery, collector);
  results.push(
    ...chainResults(
      term,
      discovery.sellers.map((seller) => seller.owner),
      chain,
    ),
  );
  return (
    <PageFrame title="Search Explorer" crumb="Search">
      <SectionTitle title="Search results" meta={term} />
      <div className="rounded-xl border border-line bg-panel p-2 text-sm">
        {results.length ? (
          results
        ) : (
          <p className="p-3 text-muted">
            No matches in the model catalog, seller directory or recent
            operations.
          </p>
        )}
      </div>
      {discovery.error || collector.error || chain.error ? (
        <p className="mt-2 text-xs text-dim">
          Some sources are unavailable. Results may be incomplete.
        </p>
      ) : null}
    </PageFrame>
  );
}

function chainResults(
  term: string,
  owners: string[],
  chain: Awaited<ReturnType<typeof getChainTxs>>,
) {
  const results = [];
  const addresses = new Set(
    [
      ...owners,
      ...chain.transactions.flatMap((tx) => [tx.channel, ...tx.recipients]),
      chain.treasury,
      chain.programId,
    ].filter(Boolean),
  );
  for (const address of addresses)
    if (address.includes(term))
      results.push(
        <Link
          key={addressHref(address)}
          href={addressHref(address)}
          className={rowClass}
        >
          <span>
            <small className="block text-dim">Address</small>
            <span className="break-all font-mono">{address}</span>
          </span>
        </Link>,
      );
  for (const tx of chain.transactions)
    if (tx.signature.includes(term))
      results.push(
        <Link
          key={operationHref(tx)}
          href={operationHref(tx)}
          className={rowClass}
        >
          <span>
            <small className="block text-dim">{CHAIN_TX_LABELS[tx.kind]}</small>
            <span className="break-all font-mono">{tx.signature}</span>
          </span>
        </Link>,
      );
  return results;
}

function catalogResults(
  term: string,
  discovery: Awaited<ReturnType<typeof getDiscovery>>,
  collector: Awaited<ReturnType<typeof getCollector>>,
) {
  const lower = term.toLowerCase();
  const matches = (...values: (string | null | undefined)[]) =>
    values.some((value) => value?.toLowerCase().includes(lower));
  const models = modelRows(
    summarizeOffers(discovery).models,
    collector.models,
  ).filter((model) =>
    matches(
      model.modelId,
      modelLab(model.modelId),
      model.variant,
      model.quantization,
    ),
  );
  const nodes = new Map(
    discovery.network?.nodes.map((node) => [node.nodeId, node]),
  );
  const sellers = new Set([
    ...nodes.keys(),
    ...discovery.sellers.map((seller) => seller.nodeId),
  ]);
  const results = [];
  for (const model of models) {
    results.push(
      <Link key={modelHref(model)} href={modelHref(model)} className={rowClass}>
        <ModelLogo modelId={model.modelId} />
        <span>
          <small className="block text-dim">
            {modelLab(model.modelId) ?? 'Unknown lab'}
          </small>
          <span className="font-mono">
            {[model.modelId, model.variant, model.quantization]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </Link>,
    );
  }
  for (const id of sellers) {
    const node = nodes.get(id);
    if (matches(id, node?.name, node?.github?.account))
      results.push(
        <Link key={id} href={sellerHref(id)} className={rowClass}>
          <Identicon nodeId={id} />
          <span>
            <small className="block text-dim">Seller</small>
            {node?.name ?? node?.github?.account ?? short(id)}
          </span>
        </Link>,
      );
  }
  return results;
}
