import Link from 'next/link';
import { notFound } from 'next/navigation';

import { cx } from '../../../components/board/cx';
import { SURFACE } from '../../../components/board/styles';
import { OperationChip } from '../../../components/channel-txs';
import { PageFrame } from '../../../components/page-frame';
import { SellerCell } from '../../../components/seller-cell';
import { Addr, SectionTitle, Unavailable } from '../../../components/ui';
import { getChainTxs } from '../../../lib/chain-txs';
import {
  operationBefore,
  operationId,
  sellerOwners,
  txRow,
  type ChainTx,
} from '../../../lib/chain-txs-shape';
import { explorerTxUrl } from '../../../lib/config';
import { PAGES } from '../../../lib/constants';
import { getDiscovery } from '../../../lib/discovery-render';
import { count } from '../../../lib/format';
import {
  githubByNode,
  namesByNode,
  sellerHref,
} from '../../../lib/seller-identity';

export const dynamic = 'force-dynamic';

function OperationFields({
  tx,
  row,
}: {
  tx: ChainTx;
  row: ReturnType<typeof txRow>;
}) {
  const fields = [
    ['Time (UTC)', row.time],
    ['Slot', count(tx.slot)],
    ['Instruction', count(tx.instructionIndex)],
    ['Amount (USDC)', row.amount],
    ['Gyblos fee (USDC)', row.parts.gyblosFees],
    ['Program (USDC)', row.parts.programTreasury],
    ['To buyer (USDC)', row.parts.refunded],
  ];
  return (
    <>
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt className="text-sm text-muted">{label}</dt>
          <dd className="font-mono">{value ?? '—'}</dd>
        </div>
      ))}
    </>
  );
}

function Recipients({ addresses }: { addresses: string[] }) {
  if (!addresses.length) return null;
  return (
    <div>
      <dt className="text-sm text-muted">Recipients</dt>
      <dd className="flex flex-col items-start font-mono">
        {addresses.map((address) => (
          <Addr key={address} value={address} />
        ))}
      </dd>
    </div>
  );
}

export default async function OperationPage({
  params,
}: {
  params: Promise<{ operation: string }>;
}) {
  const id = (await params).operation;
  const before = operationBefore(id);
  if (!before) notFound();
  const [page, snapshot] = await Promise.all([
    getChainTxs(before),
    getDiscovery(),
  ]);
  if (page.error)
    return (
      <PageFrame title="Gyblos operation" crumb="Operation">
        <Unavailable title="Operation" />
      </PageFrame>
    );
  const tx = page.transactions.find((item) => operationId(item) === id);
  if (!tx) notFound();
  const row = txRow(tx, sellerOwners(snapshot.sellers), page.treasury);
  const seller = row.seller;
  return (
    <PageFrame title="Gyblos operation" crumb={row.label}>
      <SectionTitle
        title="Operation"
        meta={<Link href={PAGES.transactions}>All transactions →</Link>}
      />
      <section className={cx('space-y-5 p-5', SURFACE.panel)}>
        <OperationChip kind={row.kind} />
        <p className="break-all font-mono text-sm">{tx.signature}</p>
        <dl className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <OperationFields tx={tx} row={row} />
          <div>
            <dt className="text-sm text-muted">Channel</dt>
            <dd className="font-mono">
              <Addr value={tx.channel} />
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Payments program</dt>
            <dd className="font-mono">
              <Addr value={page.programId} />
            </dd>
          </div>
          <Recipients addresses={tx.recipients} />
          {seller && (
            <div>
              <dt className="text-sm text-muted">Seller</dt>
              <dd>
                <SellerCell
                  nodeId={seller.nodeId}
                  name={namesByNode(snapshot.network).get(seller.nodeId)}
                  github={
                    githubByNode(snapshot.network).get(seller.nodeId) ?? null
                  }
                  href={sellerHref(seller.nodeId)}
                />
              </dd>
            </div>
          )}
        </dl>
        {row.detail.map((note) => (
          <p className="text-sm text-muted" key={note}>
            {note}
          </p>
        ))}
        <a
          className="text-sm underline decoration-line underline-offset-2"
          href={explorerTxUrl(tx.signature)}
        >
          View transaction on Solana Explorer ↗
        </a>
      </section>
    </PageFrame>
  );
}
