import { Minus, Plus } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { IconButton } from './UI';

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
}: {
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
}) {
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
        <span className="preview-steppers">
          <IconButton
            label={'Decrease by ' + format(step) + ' ' + unit}
            disabled={disabled || !atomic}
            onClick={() => nudge(-1n)}
          >
            <Minus size={14} />
          </IconButton>
          <IconButton
            label={'Increase by ' + format(step) + ' ' + unit}
            disabled={disabled}
            onClick={() => nudge(1n)}
          >
            <Plus size={14} />
          </IconButton>
        </span>
      </div>
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
