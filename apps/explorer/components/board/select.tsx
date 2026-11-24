'use client';

// A single-value select, after BoardUI's Select (MIT, see ./LICENSE): a button trigger with a chevron
// that turns while open, and a floating list with the same row surface for hover and selection. Built on
// React Aria, so it is keyboard- and screen-reader-complete; disabled options stay listed with a hint.
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Select as AriaSelect,
  Button,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
} from 'react-aria-components';

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
}: {
  label: string;
  leadingIcon?: ReactNode;
  options: SelectOption<Id>[];
  selected: Id;
  onChange?: (id: Id) => void;
}) {
  return (
    <AriaSelect
      aria-label={label}
      selectedKey={selected}
      disabledKeys={options
        .filter((option) => option.disabled)
        .map((option) => option.id)}
      onSelectionChange={(key) => {
        const next = options.find((option) => option.id === key);
        if (next && next.id !== selected) onChange?.(next.id);
      }}
      className="group"
    >
      {({ isOpen }) => (
        <>
          <Button
            className={cx(
              'flex cursor-pointer items-center gap-2 px-3 font-mono text-xs text-ink',
              SURFACE.control,
              SURFACE.focus,
            )}
          >
            {leadingIcon}
            <SelectValue className="truncate" />
            <ChevronDown
              aria-hidden
              className={cx(
                'size-3.5 shrink-0 text-muted transition-transform duration-200',
                isOpen && 'rotate-180',
              )}
            />
          </Button>
          <Popover
            offset={6}
            placement="bottom end"
            className="min-w-(--trigger-width) rounded-xl border border-line bg-panel p-1.5 shadow-lg outline-none transition duration-150 ease-out data-[entering]:scale-95 data-[entering]:opacity-0 data-[exiting]:scale-95 data-[exiting]:opacity-0"
          >
            <ListBox className="flex flex-col gap-0.5 outline-none">
              {options.map((option) => (
                <ListBoxItem
                  key={option.id}
                  id={option.id}
                  textValue={option.label}
                  className={({ isFocused, isSelected, isDisabled }) =>
                    cx(
                      'flex cursor-pointer items-center justify-between gap-4 rounded-lg px-2.5 py-2 font-mono text-xs text-ink outline-none',
                      (isFocused || isSelected) && 'bg-raised',
                      isDisabled && 'cursor-not-allowed text-dim',
                    )
                  }
                >
                  {({ isSelected }) => (
                    <OptionRow option={option} selected={isSelected} />
                  )}
                </ListBoxItem>
              ))}
            </ListBox>
          </Popover>
        </>
      )}
    </AriaSelect>
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
