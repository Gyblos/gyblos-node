'use client';

// A single-select segmented control, after BoardUI's SegmentedControl (MIT, see ./LICENSE): a raised
// track and a panel-colored thumb behind the selected segment. Built on React Aria's ToggleButtonGroup,
// so arrow keys move focus and Space/Enter select; the selection can't be emptied.
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';

export function SegmentedControl<Value extends string | number>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: Value; label: string }[];
  selected: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[selected]}
      onSelectionChange={(keys) => {
        const next = options.find((option) => keys.has(option.value));
        if (next && next.value !== selected) onChange(next.value);
      }}
      className="inline-flex items-center gap-0.5 rounded-lg bg-raised p-1"
    >
      {options.map((option) => (
        <ToggleButton
          key={option.value}
          id={option.value}
          className="cursor-pointer rounded-md px-2.5 py-1 font-mono text-xs text-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-signal data-[selected]:bg-bg data-[selected]:text-ink data-[selected]:shadow-sm"
        >
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
