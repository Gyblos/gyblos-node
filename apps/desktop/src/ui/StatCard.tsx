import { ChartBar, Question, type Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { USAGE_CALENDAR } from './constants';
import { IconButton } from './UI';

const MIN_VISIBLE_CHANGE = 0.1;
const metricNumber = new Intl.NumberFormat();
const metricPercent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="preview-metric-region">
      <div className="preview-metric-grid">{children}</div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  icon: IconComponent = ChartBar,
  change,
  comparison = 'Change from the same portion of the previous period',
  detail,
  help,
}: {
  label: string;
  value: string | number | null;
  icon?: Icon;
  change?: number | null;
  comparison?: string;
  detail?: string;
  help?: string;
}) {
  return (
    <dl className="preview-metric-card">
      <dt>
        <span className="preview-metric-icon" aria-hidden="true">
          <IconComponent size={17} />
        </span>
        {label}
        {help && (
          <IconButton
            className="preview-info-tip"
            label={'About ' + label}
            title={help}
          >
            <Question size={14} />
          </IconButton>
        )}
      </dt>
      <dd>
        <span>
          {typeof value === 'number'
            ? metricNumber.format(value)
            : (value ?? '—')}
        </span>
        <small
          className="preview-metric-change"
          data-direction={
            change == null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down'
          }
          title={change == null ? 'Percentage change unavailable' : comparison}
        >
          {change == null
            ? '—'
            : change !== 0 && Math.abs(change) < MIN_VISIBLE_CHANGE
              ? (change > 0 ? '+' : '−') + '<0.1%'
              : metricPercent.format(change / USAGE_CALENDAR.percentScale)}
          <span className="sr-only">
            {' '}
            {change == null ? 'Percentage change unavailable' : comparison}
          </span>
        </small>
        {detail && <small className="preview-metric-detail">{detail}</small>}
      </dd>
    </dl>
  );
}
