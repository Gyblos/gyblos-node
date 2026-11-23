import type { KeyboardEvent } from 'react';

export function moveMenuFocus(event: KeyboardEvent<HTMLElement>) {
  const typing = event.target instanceof HTMLInputElement;
  if (typing && event.key === 'Enter') {
    event.preventDefault();
    return;
  }
  if (typing && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "[role^='menuitem']:not(:disabled)",
    ) ?? [],
  );
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
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
}
