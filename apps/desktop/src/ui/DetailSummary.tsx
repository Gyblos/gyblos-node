import type { ReactNode } from 'react';

import type { Tone } from './status-tone';
import { Tag } from './Tag';

export type DetailItem = { label: string; value: ReactNode; note?: string };
export function DetailSummary({
  status,
  meta,
  totals,
  rows = [],
}: {
  status?: { label: string; tone: Tone };
  meta?: string;
  totals: DetailItem[];
  rows?: DetailItem[];
}) {
  return (
    <div className="pk-detail">
      {(status || meta) && (
        <div className="preview-detail-head">
          {status && (
            <Tag tone={status.tone} dot>
              {status.label}
            </Tag>
          )}
          {meta && <span className="ui-help-text">{meta}</span>}
        </div>
      )}
      <dl className="preview-detail-totals">
        {totals.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      {rows.length > 0 && (
        <dl className="preview-detail-list">
          {rows.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                <span>{item.value}</span>
                {item.note && <small>{item.note}</small>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
