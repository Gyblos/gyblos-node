import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { MENU_GEOMETRY } from './constants';
import { moveMenuFocus } from './menu-keyboard';

const EDGE = 8;

function positionChoices(menu: HTMLDivElement, trigger: HTMLElement) {
  const anchor = trigger.getBoundingClientRect();
  const right = window.innerWidth - anchor.right - EDGE;
  const left = anchor.left - EDGE;
  const width = Math.min(MENU_GEOMETRY.WIDTH, window.innerWidth - 2 * EDGE);
  menu.style.width = width + 'px';
  const fits = right >= width || left >= width;
  const x = fits
    ? right >= width
      ? anchor.right
      : anchor.left - width
    : Math.max(EDGE, Math.min(anchor.left, window.innerWidth - width - EDGE));
  menu.style.left = x + 'px';
  menu.style.top =
    Math.max(
      EDGE,
      Math.min(
        fits ? anchor.top : anchor.bottom,
        window.innerHeight - menu.offsetHeight - EDGE,
      ),
    ) + 'px';
}
export function SellerChoices({
  name,
  flyout,
  onDismiss,
  children,
}: {
  name: string;
  flyout: boolean;
  onDismiss(): void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = panel.current;
    const trigger =
      menu?.parentElement?.querySelector<HTMLElement>('[data-model-row]');
    if (!flyout || !menu || !trigger) return;
    const position = () => positionChoices(menu, trigger);
    menu.showPopover();
    position();
    menu
      .querySelector<HTMLElement>(
        '[aria-checked="true"],[role="menuitemradio"]',
      )
      ?.focus();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      menu.hidePopover();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [flyout, name]);
  return (
    <div
      ref={panel}
      role={flyout ? 'menu' : 'group'}
      aria-label={'Seller for ' + name}
      popover={flyout ? 'auto' : undefined}
      className={
        flyout
          ? 'compact-dropdown preview-seller-flyout'
          : 'seller-menu-choices'
      }
      onToggle={(event) => {
        if (flyout && event.newState === 'closed') onDismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || (flyout && event.key === 'Escape')) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.parentElement
            ?.querySelector<HTMLElement>('[data-model-row]')
            ?.focus();
          onDismiss();
        } else if (flyout) {
          moveMenuFocus(event);
          event.stopPropagation();
        }
      }}
    >
      {flyout && (
        <div className="preview-flyout-title">
          <strong>{name}</strong>
          <small>Choose a seller</small>
        </div>
      )}
      {children}
    </div>
  );
}
