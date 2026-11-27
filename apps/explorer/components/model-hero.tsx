import { ArrowDownToLine, ArrowUpFromLine, Ruler, Server } from 'lucide-react';
import Link from 'next/link';

import { count, percent, pricePerMtok } from '../lib/format';
import { modelMaker, type ModelView } from '../lib/model-catalog';
import type { ModelNow } from '../lib/model-page';
import { modelHref, modelKey } from '../lib/offers';
import type { RangeDays } from '../lib/range';
import { Chip } from './board/chip';
import { cx } from './board/cx';
import { StatCard } from './board/stat-card';
import { SURFACE } from './board/styles';
import { ModelCategories } from './model-categories';
import { ModelLogo } from './model-logo';

interface Variant {
  modelId: string;
  variant: string | null;
  quantization: string | null;
}

const UNAVAILABLE = 'Index unavailable';
const variantText = (item: Omit<Variant, 'modelId'>) =>
  [item.variant, item.quantization].filter(Boolean).join(' · ') || 'Default';

function price(atomic: bigint | null, free: number) {
  if (atomic !== null) return pricePerMtok(String(atomic));
  return free ? 'Free only' : '—';
}

function sellersCaption(now: ModelNow) {
  if (!now.sellers) return 'No seller offers it now';
  const split = `${count(now.free)} free · ${count(now.paid)} paid`;
  return now.weekUptime === null
    ? split
    : `${split} · avg 7 d uptime ${percent(now.weekUptime)}`;
}

function NowCards({ now, known }: { now: ModelNow; known: boolean }) {
  const shown = (value: string) => (known ? value : '—');
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        icon={Server}
        label="Sellers offering now"
        value={shown(count(now.sellers))}
        caption={known ? sellersCaption(now) : UNAVAILABLE}
      />
      <StatCard
        icon={ArrowDownToLine}
        label="Lowest paid input / 1M"
        value={shown(price(now.minInput, now.free))}
        caption={known ? 'USDC per million input tokens' : UNAVAILABLE}
        money={known && now.minInput !== null}
      />
      <StatCard
        icon={ArrowUpFromLine}
        label="Lowest paid output / 1M"
        value={shown(price(now.minOutput, now.free))}
        caption={known ? 'USDC per million output tokens' : UNAVAILABLE}
        money={known && now.minOutput !== null}
      />
      <StatCard
        icon={Ruler}
        label="Largest context"
        value={shown(now.context ? count(now.context) : '—')}
        caption={known ? 'Tokens' : UNAVAILABLE}
      />
    </div>
  );
}

export function ModelTitle({
  modelId,
  view,
}: {
  modelId: string;
  view: ModelView;
}) {
  return (
    <span className="flex items-center gap-4">
      <ModelLogo modelId={modelId} view={view} size="lg" />
      <span className="min-w-0 break-all">{modelId}</span>
    </span>
  );
}

export function ModelHero({
  model,
  view,
  now,
  known,
  variants,
  directory,
  days,
  closed,
}: {
  model: Variant;
  view: ModelView;
  now: ModelNow;
  known: boolean;
  variants: Variant[];
  directory: string;
  days: RangeDays;
  closed?: boolean;
}) {
  const link = cx('rounded-full', SURFACE.focus);
  return (
    <section aria-label="Model summary" className="mt-4 grid gap-3">
      <div className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4 sm:flex-row sm:items-center sm:p-6">
        <div className="min-w-0 flex-1">
          <p className="text-body-medium text-text-primary">
            {modelMaker(view)}
          </p>
          <p className="font-mono text-sm text-muted">{variantText(model)}</p>
          {view.categories.length ? (
            <ModelCategories categories={view.categories} />
          ) : (
            <span className="mt-1 flex">
              <Chip>{known ? 'Not classified yet' : UNAVAILABLE}</Chip>
            </span>
          )}
        </div>
        <nav
          aria-label="Other variants"
          className="flex flex-wrap items-center gap-2 text-sm sm:max-w-xs sm:justify-end"
        >
          {variants.map((item) => (
            <Link
              key={modelKey(item)}
              href={modelHref(item, days, closed)}
              title={[item.modelId, variantText(item)].join(' ')}
              className={cx(
                link,
                'border border-line px-3 py-1.5 font-mono text-xs text-muted hover:text-ink',
              )}
            >
              {variantText(item)}
            </Link>
          ))}
          <Link
            href={directory}
            className={cx(link, 'px-2 py-1.5 text-muted hover:text-ink')}
          >
            All models →
          </Link>
        </nav>
      </div>
      <NowCards now={now} known={known} />
    </section>
  );
}
