// Anchored, non-modal desktop menu with shared sizing, keyboard navigation and dismissal.
// The native popover layer prevents clipping without blocking the surrounding chat.
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { MENU_GEOMETRY } from './constants';
import { moveMenuFocus } from './menu-keyboard';
import { Button, SearchField } from './UI';

export function Dropdown({
  label,
  trigger,
  triggerId,
  onOpen,
  disabled,
  className = '',
  iconOnly = false,
  searchLabel,
  menuTitle,
  panelClassName = '',
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerId?: string;
  onOpen?(): void;
  disabled?: boolean;
  className?: string;
  iconOnly?: boolean;
  searchLabel?: string;
  menuTitle?: string;
  panelClassName?: string;
  children: (close: () => void, query: string) => ReactNode;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const content = useRef<HTMLDivElement>(null);
  function show() {
    if (!open) onOpen?.();
    setQuery('');
    setOpen(true);
  }
  function close() {
    panel.current?.hidePopover();
    setOpen(false);
    button.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open || !panel.current || !button.current) return;
    if (disabled) {
      panel.current.hidePopover();
      return;
    }
    const menu = panel.current;
    const anchor = button.current;
    function position() {
      const bounds = anchor.getBoundingClientRect();
      const gutter = 12;
      const gap = Number.parseFloat(
        getComputedStyle(menu).getPropertyValue('--overlay-gap'),
      );
      const split = menu.dataset.split === 'true';
      const widthLimit = window.innerWidth - 2 * gutter;
      menu.style.width = split
        ? Math.min(
            MENU_GEOMETRY.WIDTH,
            (widthLimit - MENU_GEOMETRY.FLYOUT_GAP) / 2,
          ) + 'px'
        : `min(var(--seller-menu-width, ${MENU_GEOMETRY.WIDTH}px), ${widthLimit}px)`;
      const width = menu.getBoundingClientRect().width;
      menu.style.maxHeight = 'none';
      const below = window.innerHeight - bounds.bottom - gutter - gap;
      const above = bounds.top - gutter - gap;
      const up = anchor.closest('.composer')
        ? above >= Math.min(menu.scrollHeight, MENU_GEOMETRY.WIDTH) ||
          above > below
        : below < Math.min(menu.scrollHeight, MENU_GEOMETRY.WIDTH) &&
          above > below;
      const available = up ? above : below;
      menu.style.maxHeight = `${Math.max(MENU_GEOMETRY.MIN_TOP, available)}px`;
      menu.style.left = `${Math.max(gutter, Math.min(bounds.left, window.innerWidth - width - gutter - (split ? width + MENU_GEOMETRY.FLYOUT_GAP : 0)))}px`;
      menu.style.top = up ? 'auto' : `${bounds.bottom + gap}px`;
      menu.style.bottom = up
        ? `${window.innerHeight - bounds.top + gap}px`
        : 'auto';
      menu.dataset.direction = up ? 'up' : 'down';
    }
    menu.showPopover();
    position();
    const observer = new ResizeObserver(position);
    if (content.current) observer.observe(content.current);
    (searchLabel
      ? menu.querySelector<HTMLElement>('input')
      : (menu.querySelector<HTMLElement>('[aria-checked="true"]') ??
        menu.querySelector<HTMLElement>("[role^='menuitem']"))
    )?.focus();
    window.addEventListener('resize', position);
    const outside = (event: Event) => {
      if (!(event.target instanceof Node && menu.contains(event.target)))
        position();
    };
    window.addEventListener('scroll', outside, true);
    menu.addEventListener(MENU_GEOMETRY.REPOSITION, position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', outside, true);
      menu.removeEventListener(MENU_GEOMETRY.REPOSITION, position);
    };
  }, [open, disabled, searchLabel]);
  return (
    <>
      <Button
        ref={button}
        id={triggerId}
        disabled={disabled}
        className={`ui-menu-trigger${iconOnly ? ' ui-icon-button' : ''} ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            show();
          }
        }}
      >
        {trigger}
      </Button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        inert={!open}
        role="menu"
        aria-label={label}
        className={`compact-dropdown ${panelClassName}`}
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          moveMenuFocus(event);
        }}
      >
        {searchLabel && (
          <SearchField
            compact
            label={searchLabel}
            placeholder={`${searchLabel}…`}
            value={query}
            onValueChange={setQuery}
            className="dropdown-search"
          />
        )}
        <div ref={content} className="dropdown-content">
          {menuTitle && <p className="ui-menu-caption">{menuTitle}</p>}
          {children(close, query)}
        </div>
      </div>
    </>
  );
}
