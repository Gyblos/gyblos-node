import type { KeyboardEvent } from 'react';

export type FilterOption<T extends string> = {
  value: T;
  label: string;
  count: number;
};
export function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly FilterOption<T>[];
  value: T;
  onChange(value: T): void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    event.currentTarget
      .querySelector<HTMLButtonElement>('[data-value="' + next.value + '"]')
      ?.focus();
  };
  return (
    <div
      className="pk-chips"
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          <span className="pk-count">{option.count}</span>
        </button>
      ))}
    </div>
  );
}
