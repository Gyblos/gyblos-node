// Owns the Network section: sellers online and offline, models offered with their cheapest prices, each
// online seller's offers and uptime, and the registered sellers not online now, from the discovery index.
import { DISPLAY } from '../lib/constants';
import { getDiscovery, type Seller } from '../lib/discovery';
import { count, percent, pricePerMtok, short, usdc, utc } from '../lib/format';
import {
  notOnline,
  type NetworkNode,
  type NetworkStatus,
} from '../lib/network-status';
import { summarizeOffers, uptimeRatio } from '../lib/offers';
import { Chip } from './board/chip';
import { StatusDot } from './board/status-dot';
import {
  Addr,
  ModelName,
  moneyCell,
  numberCell,
  SectionTitle,
  Stat,
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {snapshot.network ? (
          <Stat
            label="Sellers online · offline"
            value={`${snapshot.network.counts.online} · ${snapshot.network.counts.offline}`}
          />
        ) : (
          <Stat
            label="Sellers online"
            value={String(snapshot.sellers.length)}
          />
        )}
        <Stat label="Models" value={String(summary.models.size)} />
        <Stat
          label="Free · paid offers"
          value={`${summary.free} · ${summary.offers - summary.free}`}
        />
        <Stat label="Uptime 24 h" value={ratioText(summary.averageDayUptime)} />
      </div>

      <SectionTitle title="Models" />
      <Table
        head={[
          { label: 'Model' },
          { label: 'Sellers', right: true },
          { label: 'Free', right: true },
          { label: 'Lowest input / 1M', right: true },
          { label: 'Lowest output / 1M', right: true },
          { label: 'Max context', right: true },
        ]}
      >
        {[...summary.models].map(([name, model]) => (
          <tr key={name} className="border-t border-line">
            <td className={td}>
              <ModelName modelId={name} variant={null} quantization={null} />
            </td>
            <td className={numberCell}>{model.sellers}</td>
            <td className={numberCell}>{model.free}</td>
            <td className={moneyCell}>{priceText(model.minInput)}</td>
            <td className={moneyCell}>{priceText(model.minOutput)}</td>
            <td className={numberCell}>{count(model.context)}</td>
          </tr>
        ))}
      </Table>

      <SectionTitle title="Sellers" />
      <SellersTable sellers={snapshot.sellers} />
      {snapshot.network ? <NotOnlineTable network={snapshot.network} /> : null}
    </>
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
