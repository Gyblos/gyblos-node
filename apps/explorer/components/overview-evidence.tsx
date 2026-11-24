import Link from 'next/link';

import { getChainTxs } from '../lib/chain-txs';
import { txRow } from '../lib/chain-txs-shape';
import { NETWORKS } from '../lib/config';
import { PAGES, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { count, pricePerMtok, short, utc } from '../lib/format';
import { modelKey } from '../lib/offers';
import type { ExplorerQuery } from '../lib/paging';
import {
  emptySellersMessage,
  githubByNode,
  sellerHref,
  verifiedOnly,
} from '../lib/seller-identity';

export async function OverviewOffers({ query }: { query: ExplorerQuery }) {
  const snapshot = await getDiscovery();
  const sellers = query.verified
    ? verifiedOnly(snapshot.sellers, githubByNode(snapshot.network))
    : snapshot.sellers;
  const rows = sellers.flatMap((seller) =>
    seller.models.map((model) => ({ seller, model })),
  );
  return (
    <section className="ov-panel" id={PAGING.anchors.sellers}>
      <div className="ov-heading">
        <h3>Inference offers</h3>
        <Link href={PAGES.models}>All models ↗</Link>
      </div>
      <p className="ov-meta">
        {snapshot.error
          ? 'Discovery unavailable'
          : `Published as of ${utc(snapshot.datedAt ?? snapshot.generatedAt)}`}
      </p>
      {rows.length ? (
        <div
          className="ov-scroll"
          tabIndex={0}
          role="region"
          aria-label="Inference offers"
        >
          <table>
            <thead>
              <tr>
                {[
                  'Model / variant',
                  'Seller',
                  'Context',
                  'Input USDC / 1M',
                  'Output USDC / 1M',
                ].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, PAGING.rowsPerPage).map(({ seller, model }) => (
                <tr key={seller.nodeId + modelKey(model)}>
                  <td>
                    {[model.modelId, model.variant, model.quantization]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td>
                    <Link
                      href={sellerHref(seller.nodeId, query)}
                      title={seller.nodeId}
                    >
                      {short(seller.nodeId)}
                    </Link>
                  </td>
                  <td>{count(model.contextTokens)}</td>
                  <td>{pricePerMtok(model.pricing.inputAtomicPerMtok)}</td>
                  <td>{pricePerMtok(model.pricing.outputAtomicPerMtok)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !snapshot.error && (
          <p>
            {emptySellersMessage(
              sellers,
              query.verified,
              snapshot.network !== null,
            )}
          </p>
        )
      )}
    </section>
  );
}
export async function OverviewOperations() {
  const page = await getChainTxs(null);
  return (
    <section className="ov-panel" id={PAGING.anchors.transactions}>
      <div className="ov-heading">
        <h3>Latest operations</h3>
        <Link href={PAGES.transactions}>All transactions ↗</Link>
      </div>
      <p className="ov-meta">
        {NETWORKS.find((network) => network.live)?.label} · All time
      </p>
      {page.transactions.length ? (
        <div
          className="ov-scroll"
          tabIndex={0}
          role="region"
          aria-label="Latest operations"
        >
          <table>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Type</th>
                <th>USDC</th>
                <th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {page.transactions.slice(0, PAGING.rowsPerPage).map((tx) => {
                const row = txRow(tx, new Map(), page.treasury);
                return (
                  <tr key={row.key}>
                    <td>{row.time}</td>
                    <td>
                      <span className="ov-kind">{row.label}</span>
                    </td>
                    <td>{row.amount}</td>
                    <td>
                      <a href={row.href} title={tx.signature}>
                        {row.signature} ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p>
          {page.error
            ? 'Transaction history unavailable.'
            : 'No channel transactions.'}
        </p>
      )}
    </section>
  );
}
