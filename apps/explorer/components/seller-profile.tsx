import { Activity, Boxes, CalendarClock, Server } from 'lucide-react';
import type { ReactNode } from 'react';

import { NODE_STATE } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { count, percent, utc } from '../lib/format';
import {
  SELLER_STATUS_LABELS,
  sellerProfile,
  type SellerProfile,
} from '../lib/seller-profile';
import { StatCard } from './board/stat-card';
import { StatusDot } from './board/status-dot';
import { SellerCell } from './seller-cell';
import { Addr, SectionTitle, Unavailable } from './ui';

const ratioText = (ratio: number | null) =>
  ratio === null ? '—' : percent(ratio);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 min-w-0">{children}</dd>
    </div>
  );
}

function Identity({ profile }: { profile: SellerProfile }) {
  return (
    <SellerCell nodeId={profile.nodeId} github={profile.github} href={null}>
      {profile.name ? (
        <span className="flex flex-wrap items-baseline gap-x-2 break-all">
          <bdi className="text-base text-ink">{profile.name}</bdi>
          <span className="text-xs text-dim">
            self-chosen name, not verified
          </span>
        </span>
      ) : null}
    </SellerCell>
  );
}

function statusCaption(profile: SellerProfile) {
  if (profile.status === NODE_STATE.online)
    return profile.firstSeenAt
      ? `Online since ${utc(profile.firstSeenAt)}`
      : '';
  return profile.lastSeenAt ? `Last seen ${utc(profile.lastSeenAt)}` : '';
}

const uptimeCaption = (profile: SellerProfile) =>
  profile.owner ? undefined : 'Not listed now';

function OwnerField({ profile }: { profile: SellerProfile }) {
  if (!profile.owner)
    return (
      <span className="text-muted">
        Published only while the seller is online
      </span>
    );
  return (
    <span className="font-mono">
      <Addr value={profile.owner} />
    </span>
  );
}

export async function SellerProfileSection({ nodeId }: { nodeId: string }) {
  const snapshot = await getDiscovery();
  if (snapshot.error) return <Unavailable title="Seller" />;
  const dated = [
    snapshot.datedAt
      ? `Sellers and models as of ${utc(snapshot.datedAt)}.`
      : null,
    snapshot.networkDatedAt
      ? `Online, offline and not published status as of ${utc(snapshot.networkDatedAt)}; a seller in the newer seller list shows as online.`
      : null,
  ].filter(Boolean);
  const profile = sellerProfile(nodeId, snapshot);
  return (
    <>
      <SectionTitle
        title="Seller"
        meta={`index read ${utc(snapshot.generatedAt)}`}
      />
      {dated.length ? (
        <p className="-mt-2 mb-3 text-xs text-dim">{dated.join(' ')}</p>
      ) : null}
      <div className="rounded-xl border border-line bg-panel p-4 text-sm sm:p-5">
        <Identity profile={profile} />
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="NodeId">
            <span className="font-mono text-xs break-all">{nodeId}</span>
          </Field>
          <Field label="Owner address (self-declared)">
            <OwnerField profile={profile} />
          </Field>
        </dl>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Server}
          label="Status"
          value={
            <span className="inline-flex flex-wrap items-center gap-2">
              {profile.status === NODE_STATE.online ? <StatusDot /> : null}
              {SELLER_STATUS_LABELS[profile.status]}
            </span>
          }
          caption={statusCaption(profile) || undefined}
        />
        <StatCard
          icon={Activity}
          label="Uptime 24 h"
          value={ratioText(profile.dayUptime)}
          caption={uptimeCaption(profile)}
        />
        <StatCard
          icon={CalendarClock}
          label="Uptime 7 d"
          value={ratioText(profile.weekUptime)}
          caption={uptimeCaption(profile)}
        />
        <StatCard
          icon={Boxes}
          label="Models offered now"
          value={count(profile.offers.length)}
        />
      </div>
      {snapshot.network ? null : (
        <p className="mt-2 text-xs text-dim">
          The index&apos;s network status could not be read: only online sellers
          are known.
        </p>
      )}
    </>
  );
}
