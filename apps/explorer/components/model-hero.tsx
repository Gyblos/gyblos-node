import { ArrowDownToLine, ArrowUpFromLine, Ruler, Server } from 'lucide-react';
import Link from 'next/link';

import { count, percent, pricePerMtok } from '../lib/format';
import { modelMaker, type ModelView } from '../lib/model-catalog';
import type { ModelNow } from '../lib/model-page';
import { modelHref } from '../lib/offers';
import type { RangeDays } from '../lib/range';
import { Chip } from './board/chip';
import { StatCard } from './board/stat-card';
import { ModelCategories } from './model-categories';
import { ModelLogo } from './model-logo';

interface Variant {
  modelId: string;
  variant: string | null;
  quantization: string | null;
}

const variantText = (item: Omit<Variant, 'modelId'>) =>
  [item.variant, item.quantization].filter(Boolean).join(' · ') || 'Default';

function price(atomic: bigint | null, free: number) {
  if (atomic !== null) return pricePerMtok(String(atomic));
  return free ? 'Free' : '—';
}

function NowCards({ now }: { now: ModelNow }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        icon={Server}
        label="Sellers offering now"
        value={count(now.sellers)}
        caption={
          now.sellers
            ? `${count(now.free)} free · ${count(now.paid)} paid`
            : 'No seller offers it now'
        }
      />
      <StatCard
        icon={ArrowDownToLine}
        label="Lowest input / 1M"
        value={price(now.minInput, now.free)}
        caption="USDC per million input tokens"
        money={now.minInput !== null}
      />
      <StatCard
        icon={ArrowUpFromLine}
        label="Lowest output / 1M"
        value={price(now.minOutput, now.free)}
        caption="USDC per million output tokens"
        money={now.minOutput !== null}
      />
      <StatCard
        icon={Ruler}
        label="Largest context"
        value={now.context ? count(now.context) : '—'}
        caption={
          now.weekUptime === null
            ? 'Tokens'
            : `Tokens · sellers' 7 d uptime ${percent(now.weekUptime)}`
        }
      />
    </div>
  );
}

export function ModelHero({
  model,
  view,
  now,
  variants,
  directory,
  days,
  closed,
}: {
  model: Variant;
  view: ModelView;
  now: ModelNow;
  variants: Variant[];
  directory: string;
  days: RangeDays;
  closed?: boolean;
}) {
  return (
    <section aria-label="Model summary" className="mt-4 grid gap-3">
      <div className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4 sm:flex-row sm:items-center sm:p-6">
        <ModelLogo modelId={model.modelId} view={view} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-body-medium text-text-primary">
            {modelMaker(view)}
          </p>
          <p className="font-mono text-sm text-muted">{variantText(model)}</p>
          {view.categories.length ? (
            <ModelCategories categories={view.categories} />
          ) : (
            <span className="mt-1 flex">
              <Chip>Not classified yet</Chip>
            </span>
          )}
        </div>
        <nav
          aria-label="Related models"
          className="flex flex-wrap gap-2 text-sm sm:max-w-xs sm:justify-end"
        >
          {variants.map((item) => (
            <Link
              key={variantText(item)}
              href={modelHref(item, days, closed)}
              className="rounded-full border border-line px-3 py-1 font-mono text-xs text-muted hover:text-ink"
            >
              {variantText(item)}
            </Link>
          ))}
          <Link
            href={directory}
            className="px-1 py-1 text-muted hover:text-ink hover:underline"
          >
            All models →
          </Link>
        </nav>
      </div>
      <NowCards now={now} />
    </section>
  );
}
