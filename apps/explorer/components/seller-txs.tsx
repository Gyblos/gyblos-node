import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { getChainTxs } from '../lib/chain-txs';
import { txRow } from '../lib/chain-txs-shape';
import { DISPLAY } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { sellerHref, type SellerPageState } from '../lib/seller-page';
import { sellerProfile } from '../lib/seller-profile';
import {
  Addr,
  moneyCell,
  numberCell,
  SectionTitle,
  Table,
  td,
  timeCell,
  Unavailable,
} from './ui';

const TITLE = 'Channel transactions';
const link = 'inline-flex items-center gap-1 hover:text-brand';
const NO_OWNERS = new Map<string, never>();
const HEAD = [
  { label: 'Time (UTC)' },
  { label: 'Type' },
  { label: 'Amount (USDC)', right: true },
  { label: 'Transaction' },
  { label: 'Channel' },
];

function Note({ children }: { children: string }) {
  return (
    <>
      <SectionTitle title={TITLE} />
      <div className="rounded-2xl border border-line bg-panel p-5 text-sm text-muted">
        {children}
      </div>
    </>
  );
}

function Pager({
  href,
  newest,
  older,
}: {
  href: (before: string | null) => string;
  newest: boolean;
  older: string | null;
}) {
  if (!newest && !older) return null;
  return (
    <nav className="my-3 flex justify-end gap-4 font-mono text-xs text-muted">
      {newest ? (
        <Link className={link} href={href(null)} scroll={false}>
          Newest
        </Link>
      ) : null}
      {older ? (
        <Link className={link} href={href(older)} scroll={false}>
          Older
        </Link>
      ) : null}
    </nav>
  );
}

export async function SellerTxs({
  nodeId,
  state,
}: {
  nodeId: string;
  state: SellerPageState;
}) {
  const snapshot = await getDiscovery();
  if (snapshot.error) return <Unavailable title={TITLE} />;
  const profile = sellerProfile(nodeId, snapshot);
  if (!profile.owner)
    return (
      <Note>
        Channel transactions are found by the seller&apos;s owner address, which
        the discovery index publishes only while the seller is online.
      </Note>
    );
  const page = await getChainTxs(state.before, profile.owner);
  if (page.error) return <Unavailable title={TITLE} />;
  const href = (before: string | null) =>
    sellerHref(nodeId, { ...state, before });
  return (
    <>
      <SectionTitle
        title={TITLE}
        meta="Latest, all time · not filtered by range"
      />
      <p className="-mt-2 mb-3 text-xs text-muted">
        Channels whose payout recipient is this seller&apos;s self-declared
        owner address. Amounts are per row, as in the explorer&apos;s main list:
        do not add them up.
        {profile.ownerShared
          ? ' Other listed sellers publish the same owner address, so these channels are the owner’s, not only this seller’s.'
          : null}
      </p>
      <Pager href={href} newest={state.before !== null} older={null} />
      <Table minWidth={DISPLAY.defaultTable} head={HEAD}>
        {page.transactions.length ? null : (
          <tr>
            <td className={`${td} text-muted`} colSpan={HEAD.length}>
              {state.before
                ? 'No older transactions.'
                : 'No Gyblos channel transactions pay this owner address.'}
            </td>
          </tr>
        )}
        {page.transactions.map((tx) => {
          const row = txRow(tx, NO_OWNERS, page.treasury);
          return (
            <tr key={row.key} className="border-t border-line">
              <td className={timeCell}>{row.time}</td>
              <td className={td} title={row.kind}>
                {row.label}
              </td>
              <td
                className={row.muted ? `${numberCell} text-muted` : moneyCell}
              >
                {row.amount}
              </td>
              <td className={`${td} font-mono`}>
                <a className={link} href={row.href}>
                  {row.signature}
                  <ArrowUpRight aria-hidden className="size-3" />
                </a>
              </td>
              <td className={`${td} font-mono`}>
                <Addr value={row.channel} />
              </td>
            </tr>
          );
        })}
      </Table>
      <Pager href={href} newest={state.before !== null} older={page.next} />
    </>
  );
}
