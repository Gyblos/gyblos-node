import { Minus, Plus } from '@phosphor-icons/react';

import { IconButton } from './UI';

type CompactProps = {
  id: string;
  value: string;
  onChange(value: string): void;
  unit: string;
  parse(value: string): bigint | null;
  format(atomic: bigint): string;
  step: bigint;
  invalid: boolean;
  disabled?: boolean;
  placeholder?: string;
  describedBy?: string;
  onEnter?(): void;
  onEscape?(): void;
};
export function CompactAmount({
  id,
  value,
  onChange,
  unit,
  parse,
  format,
  step,
  invalid,
  disabled = false,
  placeholder,
  describedBy,
  onEnter,
  onEscape,
}: CompactProps) {
  const atomic = value.trim() ? parse(value.trim()) : null;
  const nudge = (direction: bigint) => {
    const next = (atomic ?? 0n) + direction * step;
    onChange(format(next > 0n ? next : 0n));
  };
  return (
    <div className="preview-compact-amount" data-invalid={invalid}>
      <input
        id={id}
        disabled={disabled}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-invalid={invalid}
        aria-describedby={describedBy}
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
          if (event.key === 'Escape' && onEscape) {
            event.preventDefault();
            onEscape();
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
          disabled={disabled}
          label={'Increase by ' + format(step) + ' ' + unit}
          onClick={() => nudge(1n)}
        >
          <Plus size={14} />
        </IconButton>
      </span>
    </div>
  );
}
