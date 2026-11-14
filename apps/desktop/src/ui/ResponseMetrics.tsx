// Shared compact response observations; missing measurements remain unknown.
import type { CSSProperties } from 'react';

import { RESPONSE_COST_KIND, RESPONSE_METRICS } from '../constants';
import { generationSpeed } from '../response-metrics';
import type { ChatMessage } from './chat-state';
import { ModelImage } from './ModelImage';

function seconds(value: number | null | undefined) {
  return value === null || value === undefined
    ? '—'
    : (value / RESPONSE_METRICS.MS_PER_SECOND).toFixed(2);
}
function TokenUsage({ message }: { message: ChatMessage }) {
  const input = message.metrics?.inputTokens ?? null;
  const output = message.metrics?.outputTokens ?? null;
  const total = input !== null && output !== null ? input + output : null;
  const style: CSSProperties & { '--meter-share': string } = {
    '--meter-share': total
      ? String(((input ?? 0) / total) * RESPONSE_METRICS.PERCENT_SCALE) + '%'
      : '0%',
  };
  return (
    <section className="ui-section ui-token-usage" aria-label="Token usage">
      <div className="ui-section-title">
        <h3>Token usage</h3>
        <span className="ui-meter-total">
          <strong>{total ?? '—'}</strong>
          <span>total</span>
        </span>
      </div>
      <div
        className="ui-meter"
        style={style}
        data-measured={total !== null && total > 0}
        aria-hidden="true"
      >
        <span />
        <span />
      </div>
      <dl className="ui-meter-legend">
        <div>
          <dt>Input</dt>
          <dd>{input ?? '—'}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{output ?? '—'}</dd>
        </div>
      </dl>
    </section>
  );
}
export function ResponseMetrics({ message }: { message: ChatMessage }) {
  const metrics = message.metrics;
  const speed = generationSpeed(metrics);
  const charge = metrics?.cost;
  return (
    <section
      className="ui-section ui-response-metrics"
      aria-label="Response metrics"
    >
      <div className="ui-toolbar ui-metric-summary">
        <ModelImage artwork={message.model.image} name={message.model.name} />
        <span className="ui-help-text">{message.model.name}</span>
      </div>
      <dl className="ui-facts ui-facts--compact ui-facts--plain ui-metric-grid">
        <div>
          <dt>Generation speed</dt>
          <dd className="ui-metric-value">
            <strong>{speed === null ? '—' : speed.toFixed(1)}</strong>
            <span>tok/s</span>
          </dd>
        </div>
        <div>
          <dt>First token</dt>
          <dd className="ui-metric-value">
            <strong>{seconds(metrics?.firstTokenMs)}</strong>
            <span>s</span>
          </dd>
        </div>
        <div>
          <dt>Round trip</dt>
          <dd className="ui-metric-value">
            <strong>{seconds(metrics?.responseMs)}</strong>
            <span>s</span>
          </dd>
        </div>
      </dl>
      <TokenUsage message={message} />
      <div className="ui-section-title ui-cost-summary">
        <span className="ui-help-text">
          {charge?.kind === RESPONSE_COST_KIND.RECORDED
            ? 'Recorded cost'
            : 'Response cost'}
        </span>
        <span className="ui-metric-money">
          {charge && <span>{charge.unit}</span>}
          <strong>{charge?.amount ?? '—'}</strong>
        </span>
      </div>
    </section>
  );
}
