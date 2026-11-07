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
import { Button, SearchField } from './UI';

export function Dropdown({
  label,
  trigger,
  className = '',
  iconOnly = false,
  searchLabel,
  children,
}: {
  label: string;
  trigger: ReactNode;
  className?: string;
  iconOnly?: boolean;
  searchLabel: string;
  children: (close: () => void, query: string) => ReactNode;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const content = useRef<HTMLDivElement>(null);
  function show() {
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
    const menu = panel.current;
    const anchor = button.current;
    function position() {
      const bounds = anchor.getBoundingClientRect();
      const gutter = 12;
      const gap = Number.parseFloat(
        getComputedStyle(menu).getPropertyValue('--overlay-gap'),
      );
      const width = Math.min(
        MENU_GEOMETRY.WIDTH,
        window.innerWidth - gutter * 2,
      );
      menu.style.width = `${width}px`;
      menu.style.maxHeight = 'none';
      const below = window.innerHeight - bounds.bottom - gutter - gap;
      const above = bounds.top - gutter - gap;
      const up =
        below < Math.min(menu.scrollHeight, MENU_GEOMETRY.WIDTH) &&
        above > below;
      const available = up ? above : below;
      menu.style.maxHeight = `${Math.max(MENU_GEOMETRY.MIN_TOP, available)}px`;
      menu.style.left = `${Math.max(gutter, Math.min(bounds.left, window.innerWidth - width - gutter))}px`;
      menu.style.top = `${up ? bounds.top - gap - Math.min(menu.scrollHeight, available) : bounds.bottom + gap}px`;
      menu.dataset.direction = up ? 'up' : 'down';
    }
    menu.showPopover();
    position();
    const observer = new ResizeObserver(position);
    if (content.current) observer.observe(content.current);
    menu.querySelector<HTMLElement>("input, [role^='menuitem']")?.focus();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);
  return (
    <>
      <Button
        ref={button}
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
        className="compact-dropdown"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          const typing = event.target instanceof HTMLInputElement;
          if (typing && event.key === 'Enter') {
            event.preventDefault();
            return;
          }
          if (typing && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
          const items = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              "[role^='menuitem']:not(:disabled)",
            ) ?? [],
          );
          const index = items.indexOf(document.activeElement as HTMLElement);
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
            return;
          if (!items.length) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : event.key === 'ArrowDown'
                  ? (index + 1) % items.length
                  : index < 0
                    ? items.length - 1
                    : (index - 1 + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        <SearchField
          compact
          label={searchLabel}
          placeholder={`${searchLabel}…`}
          value={query}
          onValueChange={setQuery}
          className="dropdown-search"
        />
        <div ref={content} className="dropdown-content">
          {children(close, query)}
        </div>
      </div>
    </>
  );
}
