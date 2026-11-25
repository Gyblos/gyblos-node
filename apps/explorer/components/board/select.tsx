'use client';

// A single-value select, after BoardUI's Select (MIT, see ./LICENSE): a button trigger with a chevron
// that turns while open, and a floating list with the same row surface for hover and selection. Built on
// React Aria, so it is keyboard- and screen-reader-complete; disabled options stay listed with a hint.
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  Select as BoardSelect,
  SelectItem,
} from '../../boardui/components/base/select/select';
import { cx } from './cx';
import { SURFACE } from './styles';

export interface SelectOption<Id extends string> {
  id: Id;
  label: string;
  // Shown after the label, e.g. "soon" for an option not yet available.
  hint?: string;
  disabled?: boolean;
  icon?: string;
}

function OptionIcon({ src }: { src?: string }) {
  if (!src) return null;
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 shrink-0 bg-contain bg-center bg-no-repeat"
      style={{ backgroundImage: `url(${src})` }}
    />
  );
}

export function Select<Id extends string>({
  label,
  options,
  selected,
  onChange,
  leadingIcon,
  size = 'md',
}: {
  label: string;
  leadingIcon?: ReactNode;
  size?: 'sm' | 'md';
  options: SelectOption<Id>[];
  selected: Id;
  onChange?: (id: Id) => void;
}) {
  const active = options.find((option) => option.id === selected);
  return (
    <BoardSelect
      size={size}
      aria-label={label}
      selectedKey={selected}
      disabledKeys={options
        .filter((option) => option.disabled)
        .map((option) => option.id)}
      triggerClassName={cx(
        SURFACE.control,
        size === 'sm' && 'pointer-fine:h-7 sm:pointer-fine:h-7',
        'font-mono text-xs',
      )}
      renderValue={() => (
        <>
          {leadingIcon}
          <OptionIcon src={active?.icon} />
          {active?.label}
        </>
      )}
      onSelectionChange={(key) => {
        const next = options.find((option) => option.id === key);
        if (next && next.id !== selected) onChange?.(next.id);
      }}
    >
      {options.map((option) => (
        <SelectItem
          key={option.id}
          id={option.id}
          textValue={option.label}
          className="justify-between font-mono text-xs"
        >
          <OptionRow option={option} selected={option.id === selected} />
        </SelectItem>
      ))}
    </BoardSelect>
  );
}

function OptionRow<Id extends string>({
  option,
  selected,
}: {
  option: SelectOption<Id>;
  selected: boolean;
}) {
  return (
    <>
      <span className="flex items-center gap-2">
        <OptionIcon src={option.icon} />
        {option.label}
        {option.hint ? (
          <span className="rounded-md bg-raised px-1.5 py-0.5 text-[10px] text-muted">
            {option.hint}
          </span>
        ) : null}
      </span>
      {selected ? <Check aria-hidden className="size-3.5 text-signal" /> : null}
    </>
  );
}
