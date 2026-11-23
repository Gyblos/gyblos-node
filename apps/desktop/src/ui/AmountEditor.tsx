import { Minus, Plus } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { IconButton } from './UI';

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
  const text = value.trim();
  const atomic = text ? parse(text) : null;
  const nudge = (direction: bigint) => {
    const next = (atomic ?? 0n) + direction * step;
    onChange(format(next > 0n ? next : 0n));
  };
  return (
    <div className="preview-amount-editor">
      <label htmlFor={id} className="preview-limit-label">
        {label}
      </label>
      <div className="preview-amount-field" data-invalid={!!error}>
        <input
          id={id}
          autoFocus={autoFocus}
          inputMode="decimal"
          autoComplete="off"
          placeholder={empty?.placeholder}
          disabled={disabled}
          value={value}
          aria-invalid={!!error}
          aria-describedby={id + '-help'}
          onChange={(event) => onChange(event.target.value.replace(',', '.'))}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              nudge(event.key === 'ArrowUp' ? 1n : -1n);
            }
            if (event.key === 'Enter' && onEnter) {
              event.preventDefault();
              onEnter();
            }
          }}
        />
        <span className="preview-amount-unit">{unit}</span>
        <AmountSteppers
          stepLabel={format(step) + ' ' + unit}
          disabled={!!disabled}
          canDecrease={!!atomic}
          nudge={nudge}
        />
      </div>
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

function AmountSteppers({
  stepLabel,
  disabled,
  canDecrease,
  nudge,
}: {
  stepLabel: string;
  disabled: boolean;
  canDecrease: boolean;
  nudge(direction: bigint): void;
}) {
  return (
    <span className="preview-steppers">
      <IconButton
        label={'Decrease by ' + stepLabel}
        disabled={disabled || !canDecrease}
        onClick={() => nudge(-1n)}
      >
        <Minus size={14} />
      </IconButton>
      <IconButton
        label={'Increase by ' + stepLabel}
        disabled={disabled}
        onClick={() => nudge(1n)}
      >
        <Plus size={14} />
      </IconButton>
    </span>
  );
}
