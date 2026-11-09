// Shared compact management layout and selectable menus; no service or payment side effects.
import { Check } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Dropdown } from './Dropdown';
import { FINANCIAL_TONE, type FinancialTone } from './history-constants';
import { MenuItem } from './UI';

export function FinancialValue({
  tone = FINANCIAL_TONE.NEUTRAL,
  children,
}: {
  tone?: FinancialTone;
  children: ReactNode;
}) {
  return (
    <span className="ui-financial-value" data-tone={tone}>
      {children}
    </span>
  );
}
export function StatePanel({
  title,
  description,
  action,
  loading = false,
  tone = FINANCIAL_TONE.NEUTRAL,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  loading?: boolean;
  tone?: FinancialTone;
}) {
  return (
    <section className="ui-state-panel" aria-live="polite" aria-busy={loading}>
      <h2>
        <FinancialValue tone={tone}>{title}</FinancialValue>
      </h2>
      <p className="ui-help-text">{description}</p>
      {action && <div className="ui-inline-actions">{action}</div>}
    </section>
  );
}
export function Pair({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="ui-facts">{children}</dl>;
}
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-section">
      <div className="ui-section-title">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export function ChoiceMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <Dropdown
      label={label}
      className="ui-select-trigger"
      trigger={value}
      searchLabel={'Search ' + label.toLowerCase()}
    >
      {(close, query) => (
        <>
          {options
            .filter((option) =>
              option.toLowerCase().includes(query.toLowerCase()),
            )
            .map((option) => (
              <MenuItem
                key={option}
                role="menuitemradio"
                checked={option === value}
                label={option}
                trailing={option === value ? <Check size={16} /> : undefined}
                onClick={() => {
                  onChange(option);
                  close();
                }}
              />
            ))}
        </>
      )}
    </Dropdown>
  );
}
