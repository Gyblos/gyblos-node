// Keeps currencies and uncertain financial outcomes separate in shared summaries.
import type { ActivityEntry } from '../activity-model';
import {
  FINANCIAL_TONE,
  HISTORY_METHOD,
  HISTORY_SOURCE,
  type HistoryMethod,
  type HistorySource,
} from './history-constants';
import { financialSummary, paymentAmount } from './history-presentation';
import { Facts, FinancialValue, Pair } from './Management';

export function HistorySummary({
  entries,
  method,
  source = HISTORY_SOURCE.ALL,
  spending = false,
}: {
  entries: ActivityEntry[];
  method: HistoryMethod;
  source?: HistorySource;
  spending?: boolean;
}) {
  const summary = financialSummary(entries, source);
  const methods =
    method === HISTORY_METHOD.ALL
      ? [HISTORY_METHOD.USDC, HISTORY_METHOD.PAYPAL]
      : [method];
  return (
    <div className="ui-money-summaries">
      {methods.map((item) => (
        <section
          className="ui-money-summary"
          aria-label={item + ' spending summary'}
          key={item}
        >
          {method === HISTORY_METHOD.ALL && (
            <h3>{item === HISTORY_METHOD.PAYPAL ? 'PayPal · USD' : 'USDC'}</h3>
          )}
          <Facts compact>
            <Pair
              label={spending ? 'Paid' : 'Recorded usage'}
              value={
                item === HISTORY_METHOD.USDC
                  ? 'Unavailable'
                  : spending
                    ? summary.paid === null
                      ? 'Unconfirmed'
                      : paymentAmount(summary.paid)
                    : paymentAmount(
                        entries.reduce(
                          (sum, row) => sum + row.recordedCents,
                          0,
                        ),
                      )
              }
            />
            <Pair
              label={spending ? 'Pending settlement' : 'Paid'}
              value={
                item === HISTORY_METHOD.USDC ? (
                  'Unavailable'
                ) : spending ? (
                  <PendingAmount value={summary.pending} />
                ) : summary.paid === null ? (
                  'Unconfirmed'
                ) : (
                  paymentAmount(summary.paid)
                )
              }
            />
            {spending && (
              <Pair
                label="Payments"
                value={item === HISTORY_METHOD.USDC ? '—' : summary.payments}
              />
            )}
          </Facts>
        </section>
      ))}
    </div>
  );
}

function PendingAmount({ value }: { value: number | null }) {
  return (
    <FinancialValue
      tone={
        value === null || value > 0
          ? FINANCIAL_TONE.PENDING
          : FINANCIAL_TONE.NEUTRAL
      }
    >
      {value === null ? 'Needs review' : paymentAmount(value)}
    </FinancialValue>
  );
}
