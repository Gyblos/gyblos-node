import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { MENU_GEOMETRY } from './constants';
import { moveMenuFocus } from './menu-keyboard';

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
    const parent = trigger.closest<HTMLElement>('.preview-model-menu');
    if (!parent) return;
    parent.dataset.split = 'true';
    const position = () => positionChoices(menu, parent);
    menu.showPopover();
    position();
    menu
      .querySelector<HTMLElement>(
        '[aria-checked="true"]:not(:disabled),[role="menuitemradio"]:not(:disabled)',
      )
      ?.focus();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      menu.hidePopover();
      delete parent.dataset.split;
      parent.dispatchEvent(new Event(MENU_GEOMETRY.REPOSITION));
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

function positionChoices(menu: HTMLElement, parent: HTMLElement) {
  parent.dispatchEvent(new Event(MENU_GEOMETRY.REPOSITION));
  const box = parent.getBoundingClientRect();
  menu.style.width = box.width + 'px';
  menu.style.left = box.right + MENU_GEOMETRY.FLYOUT_GAP + 'px';
  menu.style.top = parent.style.top;
  menu.style.bottom = parent.style.bottom;
  menu.style.maxHeight = parent.style.maxHeight;
}
