'use client';

// A single-select segmented control, after BoardUI's SegmentedControl (MIT, see ./LICENSE): a raised
// track and a panel-colored thumb behind the selected segment. Built on React Aria's ToggleButtonGroup,
// so arrow keys move focus and Space/Enter select; the selection can't be emptied.
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';

import { cx } from './cx';
import { SURFACE } from './styles';

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
      className={cx('inline-flex items-stretch gap-0.5 p-0.5', SURFACE.control)}
    >
      {options.map((option) => (
        <ToggleButton
          key={option.value}
          id={option.value}
          className={cx(
            'flex cursor-pointer items-center rounded-md px-3 font-mono text-xs text-muted transition-colors hover:text-ink data-[selected]:bg-raised data-[selected]:text-ink',
            SURFACE.focus,
          )}
        >
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
