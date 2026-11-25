'use client';

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import {
  Button as AriaButton,
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  Popover as AriaPopover,
  Select as AriaSelect,
  SelectValue as AriaSelectValue,
  type ListBoxItemProps as AriaListBoxItemProps,
  type SelectProps as AriaSelectProps,
  type SelectValueRenderProps as AriaSelectValueRenderProps,
} from 'react-aria-components';

import { cx } from '../../../utils/cx';
import {
  useDismissOnOutsidePress,
  useTriggerToggle,
} from '../../../utils/use-dismiss-on-outside-press';
import { ChevronDownSmall } from '../../foundations/icons/chevrons';
import {
  ScrollFade,
  useScrollFade,
} from '../../foundations/scroll-fade/scroll-fade';
import {
  MENU_ITEM,
  MENU_ITEM_ACTIVE,
  MENU_ITEM_COMPACT,
  MENU_ITEMS_CONTAINER,
  MENU_POPOVER_COMPACT,
  MENU_POPOVER_SURFACE,
  MENU_POPOVER_WIDTH,
} from '../dropdown/menu-styles';
import { Label } from '../input/label';

export type SelectSize = 'sm' | 'md';

export type SelectVariant = 'compact' | 'comfortable';

const SelectStyleContext = createContext<{
  size: SelectSize;
  variant: SelectVariant;
}>({
  size: 'md',
  variant: 'compact',
});

export interface SelectProps<T extends object> extends Omit<
  AriaSelectProps<T>,
  'children'
> {
  label?: ReactNode;

  className?: string;
  triggerClassName?: string;

  popoverClassName?: string;

  size?: SelectSize;

  variant?: SelectVariant;
  children: ReactNode;
  items?: Iterable<T>;

  renderValue?: (values: AriaSelectValueRenderProps<T>) => ReactNode;
  ref?: Ref<HTMLDivElement>;
}

function triggerStyles(size: SelectSize, triggerClassName?: string) {
  return cx(
    'flex w-full cursor-pointer items-center justify-between rounded-2lg',
    'border border-border-button-default bg-background-primary-default shadow-xs',
    'text-text-primary',
    'transition-[background-color,border-color,box-shadow,padding,font-size] duration-200 ease motion-reduce:transition-none',
    'hover:bg-background-primary-hover hover:border-border-button-hover',
    'outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-border-focus-ring',
    'disabled:cursor-not-allowed disabled:bg-background-primary-disabled disabled:text-text-tertiary disabled:shadow-none',
    size === 'sm'
      ? 'gap-1 px-[7px] py-1 text-body-2-medium'
      : 'gap-1.5 px-2.5 py-2 text-body-medium',
    triggerClassName,
  );
}

export function Select<T extends object>({
  label,
  className,
  triggerClassName,
  popoverClassName,
  size = 'md',
  variant = 'compact',
  children,
  items,
  renderValue,
  ref,
  ...props
}: SelectProps<T>) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  useDismissOnOutsidePress(isOpen, () => setIsOpen(false), [
    triggerRef,
    popoverRef,
  ]);
  const allowOpenChange = useTriggerToggle(isOpen, triggerRef);
  const compact = variant === 'compact';

  return (
    <AriaSelect
      ref={ref}
      {...props}
      isOpen={isOpen}
      onOpenChange={(o) => allowOpenChange(o) && setIsOpen(o)}
      className={cx(
        'group flex flex-col',
        label ? 'gap-1' : undefined,
        className,
      )}
    >
      {({ isOpen, isRequired }) => (
        <>
          {label ? <Label isRequired={isRequired}>{label}</Label> : null}
          <AriaButton
            ref={triggerRef}
            className={triggerStyles(size, triggerClassName)}
          >
            <AriaSelectValue
              className={cx(
                'flex min-w-0 items-center truncate',
                size === 'sm' ? 'gap-1' : 'gap-[5px]',
              )}
            >
              {renderValue}
            </AriaSelectValue>
            <ChevronDownSmall
              className={cx(
                'shrink-0 text-text-secondary transition-transform duration-200 ease motion-reduce:transition-none',
                size === 'sm' ? 'size-3.5' : 'size-4',
                isOpen && 'rotate-180',
              )}
            />
          </AriaButton>
          <AriaPopover
            ref={popoverRef}
            isNonModal
            offset={4}
            className={cx(
              MENU_POPOVER_SURFACE,
              'flex flex-col',
              compact
                ? [MENU_POPOVER_COMPACT, 'w-max min-w-(--trigger-width)']
                : [MENU_POPOVER_WIDTH, 'p-2'],
              popoverClassName,
            )}
          >
            <SelectStyleContext.Provider value={{ size, variant }}>
              <SelectList items={items}>{children}</SelectList>
            </SelectStyleContext.Provider>
          </AriaPopover>
        </>
      )}
    </AriaSelect>
  );
}

function SelectList<T extends object>({
  items,
  children,
}: {
  items?: Iterable<T>;
  children: ReactNode;
}) {
  const { size, variant } = useContext(SelectStyleContext);
  const fade = useScrollFade();
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    if (!list || !selected || list.scrollHeight <= list.clientHeight) return;
    const top = selected.offsetTop - list.offsetTop;
    list.scrollTop = top - (list.clientHeight - selected.offsetHeight) / 2;
  }, []);
  return (
    <div className="relative flex min-h-0 flex-col">
      <AriaListBox
        ref={listRef}
        items={items}
        onScroll={fade.onScroll}
        className={cx(
          MENU_ITEMS_CONTAINER,
          'min-h-0 overflow-y-auto overscroll-contain scroll-pt-6',
          variant === 'comfortable'
            ? 'max-h-[240px]'
            : size === 'sm'
              ? 'max-h-[219px]'
              : 'max-h-[232px]',
        )}
      >
        {children}
      </AriaListBox>
      <ScrollFade progress={fade.progress} />
    </div>
  );
}

export interface SelectItemProps extends Omit<
  AriaListBoxItemProps,
  'children'
> {
  children?: ReactNode;
}

export function SelectItem({ className, children, ...props }: SelectItemProps) {
  const { size, variant } = useContext(SelectStyleContext);
  return (
    <AriaListBoxItem
      {...props}
      className={(state) =>
        cx(
          MENU_ITEM,
          size === 'sm'
            ? [MENU_ITEM_COMPACT, 'text-body-2-medium']
            : [variant === 'compact' && MENU_ITEM_COMPACT, 'text-body-medium'],
          (state.isFocused || state.isSelected) && MENU_ITEM_ACTIVE,
          state.isDisabled && 'cursor-not-allowed text-text-disabled',
          typeof className === 'function' ? className(state) : className,
        )
      }
    >
      {children}
    </AriaListBoxItem>
  );
}
