// Owns the Network section: sellers online, models offered with their cheapest prices, and each
// seller's offers and uptime, from the discovery index.
import { DISPLAY } from '../lib/constants';
import { getDiscovery, type Seller } from '../lib/discovery';
import { count, percent, pricePerMtok, usdc, utc } from '../lib/format';
import { summarizeOffers, uptimeRatio } from '../lib/offers';
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
        <Stat label="Sellers online" value={String(snapshot.sellers.length)} />
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
            <td className={td}>{name}</td>
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
    </>
  );
}

function SellersTable({ sellers }: { sellers: Seller[] }) {
  return (
    <Table
      minWidth={DISPLAY.wideTable}
      head={[
        { label: 'Seller' },
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
            key={`${seller.nodeId}:${model.modelId}:${model.quantization}`}
            className="border-t border-line"
          >
            <td className={`${td} font-mono`} title={`Node ${seller.nodeId}`}>
              <Addr value={seller.owner} />
            </td>
            <td className={td}>
              <ModelName
                modelId={model.modelId}
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
