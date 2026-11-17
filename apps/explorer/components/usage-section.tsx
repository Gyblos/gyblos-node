// Owns the Usage section: what the metrics collector aggregated from signed receipts and observations
// over the last 30 UTC days. Free and paid are never added up; buyer counts below the public minimum
// show as "< 5".
import {
  getCollector,
  mergedLatency,
  type ModelStat,
  type NetworkDay,
} from '../lib/collector';
import { DISPLAY } from '../lib/constants';
import { count, latencyMs, usdc, utc } from '../lib/format';
import {
  headline,
  medianFirstToken,
  relayText,
  sidesOf,
  successText,
  summarizeUsage,
  tokensOut,
} from '../lib/usage';
import {
  ModelName,
  numberCell,
  SectionTitle,
  Stat,
  Table,
  td,
  Unavailable,
} from './ui';

function Buyers({ side }: { side: NetworkDay['free'] }) {
  if (!side) return <>—</>;
  return side.withheld ? (
    <span className="text-dim">&lt; {DISPLAY.minPublicBuyers}</span>
  ) : (
    <>{count(side.buyers ?? 0)}</>
  );
}

export async function UsageSection() {
  const snapshot = await getCollector();
  if (snapshot.error) return <Unavailable title="Usage" />;
  const usage = summarizeUsage(snapshot);
  return (
    <>
      <SectionTitle
        title="Usage · 30 days"
        meta={
          snapshot.aggregatedAt
            ? `updated ${utc(snapshot.aggregatedAt)}`
            : 'no data yet'
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Free requests" value={count(usage.free)} />
        <Stat label="Paid requests" value={count(usage.paid)} />
        <Stat label="Success rate" value={successText(usage.sections)} />
        <Stat label="Output tokens" value={count(usage.outputTokens)} />
        <Stat
          label="First token p50"
          value={latencyMs(medianFirstToken(usage.sections))}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Authorized (paid)" value={usdc(usage.authorized)} money />
        <Stat label="Unserved demand" value={count(usage.unserved)} />
      </div>
      <DailyTable days={usage.active} />
      <ModelsTable models={snapshot.models} />
      <DemandTable demand={usage.demand} />
    </>
  );
}

function DailyTable({ days }: { days: NetworkDay[] }) {
  return (
    <>
      <SectionTitle title="Daily" />
      <Table
        minWidth={DISPLAY.dailyTable}
        head={[
          { label: 'Day (UTC)' },
          { label: 'Free', right: true },
          { label: 'Paid', right: true },
          { label: 'Success', right: true },
          { label: 'Output tokens', right: true },
          { label: 'First token p50', right: true },
          { label: 'Buyers free · paid', right: true },
          { label: 'Relay', right: true },
        ]}
      >
        {[...days].reverse().map((day) => (
          <tr key={day.day} className="border-t border-line">
            <td className={`${td} font-mono`}>{day.day}</td>
            <td className={numberCell}>{count(headline(day.free))}</td>
            <td className={numberCell}>{count(headline(day.paid))}</td>
            <td className={numberCell}>{successText(sidesOf(day))}</td>
            <td className={numberCell}>
              {count(tokensOut(day.free) + tokensOut(day.paid))}
            </td>
            <td className={numberCell}>
              {latencyMs(medianFirstToken(sidesOf(day)))}
            </td>
            <td className={numberCell}>
              <Buyers side={day.free} /> · <Buyers side={day.paid} />
            </td>
            <td className={numberCell}>{relayText(day)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}

function ModelsTable({ models }: { models: ModelStat[] }) {
  return (
    <>
      <SectionTitle title="Models served" />
      <Table
        head={[
          { label: 'Model' },
          { label: 'Free', right: true },
          { label: 'Paid', right: true },
          { label: 'Success', right: true },
          { label: 'Output tokens', right: true },
          { label: 'Sellers', right: true },
          { label: 'Total p50', right: true },
        ]}
      >
        {models.map((model) => (
          <tr
            key={`${model.modelId}:${model.variant}:${model.quantization}`}
            className="border-t border-line"
          >
            <td className={td}>
              <ModelName
                modelId={model.modelId}
                quantization={model.quantization}
              />
            </td>
            <td className={numberCell}>{count(headline(model.free))}</td>
            <td className={numberCell}>{count(headline(model.paid))}</td>
            <td className={numberCell}>
              {successText([model.free, model.paid])}
            </td>
            <td className={numberCell}>
              {count(tokensOut(model.free) + tokensOut(model.paid))}
            </td>
            <td className={numberCell}>
              {Math.max(model.free?.sellers ?? 0, model.paid?.sellers ?? 0)}
            </td>
            <td className={numberCell}>
              {latencyMs(
                mergedLatency(
                  [
                    model.free?.sellerLatency.total,
                    model.paid?.sellerLatency.total,
                  ],
                  DISPLAY.median,
                ),
              )}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}

function DemandTable({ demand }: { demand: [string, number][] }) {
  if (!demand.length) return null;
  return (
    <>
      <SectionTitle title="Unserved demand" />
      <Table
        minWidth={DISPLAY.narrowTable}
        head={[
          { label: 'Requested model' },
          { label: 'Requests', right: true },
        ]}
      >
        {demand.map(([model, requests]) => (
          <tr key={model} className="border-t border-line">
            <td className={td}>{model}</td>
            <td className={numberCell}>{count(requests)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
