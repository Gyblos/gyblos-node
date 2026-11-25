import type { ReactNode } from 'react';

import { AmountField } from './AmountField';

type AmountProps = {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  unit: string;
  presets: readonly { value: string; label: string }[];
  empty?: { label: string; placeholder: string };
  parse(value: string): bigint | null;
  format(atomic: bigint): string;
  step: bigint;
  error: string;
  help: ReactNode;
  onEnter?(): void;
  disabled?: boolean;
  autoFocus?: boolean;
};
export function AmountEditor({
  id,
  label,
  value,
  onChange,
  unit,
  presets,
  empty,
  parse,
  format,
  step,
  error,
  help,
  onEnter,
  disabled = false,
  autoFocus = false,
}: AmountProps) {
  return (
    <div className="preview-amount-editor">
      <label htmlFor={id} className="preview-limit-label">
        {label}
      </label>
      <AmountField
        id={id}
        value={value}
        onChange={onChange}
        unit={unit}
        parse={parse}
        format={format}
        step={step}
        invalid={!!error}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={empty?.placeholder}
        describedBy={id + '-help'}
        onEnter={onEnter}
      />
      <Presets
        presets={presets}
        empty={empty}
        disabled={disabled}
        onChange={onChange}
        value={value}
      />
      <p
        id={id + '-help'}
        className={error ? 'preview-field-error' : 'ui-help-text'}
        role={error ? 'alert' : undefined}
      >
        {error || help}
      </p>
    </div>
  );
}

function Presets({
  presets,
  empty,
  disabled,
  onChange,
  value,
}: Pick<AmountProps, 'presets' | 'empty' | 'disabled' | 'onChange' | 'value'>) {
  const text = value.trim();
  return (
    <div
      className="preview-amount-presets"
      role="group"
      aria-label="Quick amounts"
    >
      {presets.map((preset) => (
        <button
          key={preset.value}
          type="button"
          disabled={disabled}
          aria-pressed={text === preset.value}
          onClick={() => onChange(preset.value)}
        >
          {preset.label}
        </button>
      ))}
      {empty && (
        <button
          type="button"
          disabled={disabled}
          aria-pressed={!text}
          onClick={() => onChange('')}
        >
          {empty.label}
        </button>
      )}
    </div>
  );
}
