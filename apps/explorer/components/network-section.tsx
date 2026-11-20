// Owns the Network section: sellers online and offline, the models offered and their cheapest prices,
// each online seller's offers and uptime, and the registered sellers not online now, from the discovery
// index. The per-model table lives in the Models section.
import { Activity, Boxes, Server, Tag } from 'lucide-react';

import { DISPLAY } from '../lib/constants';
import type { DiscoverySnapshot, Seller } from '../lib/discovery';
import { getDiscovery } from '../lib/discovery-render';
import { count, percent, pricePerMtok, short, usdc, utc } from '../lib/format';
import {
  notOnline,
  type NetworkNode,
  type NetworkStatus,
} from '../lib/network-status';
import { summarizeOffers, uptimeRatio } from '../lib/offers';
import { Flow } from './board/animated-number';
import { Chip } from './board/chip';
import { StatCard } from './board/stat-card';
import { StatusDot } from './board/status-dot';
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

export async function NetworkSection() {
  const snapshot = await getDiscovery();
  if (snapshot.error) return <Unavailable title="Network" />;
  const summary = summarizeOffers(snapshot);
  return (
    <>
      <SectionTitle title="Network" meta={utc(snapshot.generatedAt)} />
      {snapshot.staleFrom ? (
        <p className="-mt-2 mb-3 text-xs text-dim">
          The explorer last read the discovery index at{' '}
          {utc(snapshot.staleFrom)}.
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
              : `Average of ${count(summary.dayUptimes)} of ${count(snapshot.sellers.length)} online sellers`
          }
        />
      </div>

      <SectionTitle title="Sellers" />
      <SellersTable sellers={snapshot.sellers} />
      {snapshot.unreadModels.length ? (
        <p className="mt-2 text-xs text-dim">
          The explorer has not read the sellers of{' '}
          {count(snapshot.unreadModels.length)} listed models yet: this list may
          be incomplete.
        </p>
      ) : null}
      {snapshot.network ? <NotOnlineTable network={snapshot.network} /> : null}
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

function SellersTable({ sellers }: { sellers: Seller[] }) {
  return (
    <Table
      minWidth={DISPLAY.wideTable}
      head={[
        { label: 'Seller' },
        { label: 'Status' },
        { label: 'Model' },
        { label: 'Context', right: true },
        { label: 'Input / 1M', right: true },
        { label: 'Output / 1M', right: true },
        { label: 'Uptime 24 h · 7 d', right: true },
        { label: 'Online since' },
      ]}
    >
      {sellers.flatMap((seller) =>
        seller.models.map((model) => (
          <tr
            key={`${seller.nodeId}:${model.modelId}:${model.variant}:${model.quantization}`}
            className="border-t border-line"
          >
            <td className={`${td} font-mono`} title={`Node ${seller.nodeId}`}>
              <Addr value={seller.owner} />
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
        )),
      )}
    </Table>
  );
}

const STATE_LABELS: Record<Exclude<NetworkNode['state'], 'online'>, string> = {
  offline: 'Offline',
  unpublished: 'Not published',
};

// Registered or recently seen sellers without a live presence now. Offline ones were seen before;
// unpublished ones were never seen or withdrew their catalog.
function NotOnlineTable({ network }: { network: NetworkStatus }) {
  const nodes = notOnline(network);
  if (!nodes.length) return null;
  const { offline, unpublished } = network.counts;
  return (
    <>
      <SectionTitle
        title="Not online"
        meta={`${count(offline)} offline · ${count(unpublished)} not published`}
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
        {nodes.map((node) => (
          <tr key={node.nodeId} className="border-t border-line">
            <td className={`${td} font-mono`} title={`Node ${node.nodeId}`}>
              {short(node.nodeId)}
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
      {network.truncated ? (
        <p className="mt-2 text-xs text-dim">
          The index reached one of its limits: this list and its counts may be
          incomplete.
        </p>
      ) : null}
    </>
  );
}
