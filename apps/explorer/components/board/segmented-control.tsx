'use client';

import {
  SegmentedControl as BoardControl,
  SegmentedControlItem,
} from '../../boardui/components/base/segmented-control/segmented-control';

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
    <BoardControl
      aria-label={label}
      selectedKeys={[selected]}
      onSelectionChange={(keys) => {
        const next = options.find((option) => keys.has(option.value));
        if (next && next.value !== selected) onChange(next.value);
      }}
      className="border border-line"
    >
      {options.map((option) => (
        <SegmentedControlItem
          key={option.value}
          id={option.value}
          className="min-h-8 min-w-8 font-mono text-xs sm:pointer-fine:min-h-0 sm:pointer-fine:min-w-0"
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </BoardControl>
  );
}
